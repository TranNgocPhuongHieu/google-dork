import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { config, RuntimeConfig } from './config';

export type ProxyKind = 'private' | 'public' | 'google_public' | 'rotating';

export interface ProxyEntry {
  url: string;
  kind: ProxyKind;
  label: string;
  resetUrl?: string;
}

export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

interface ProxyState {
  entry: ProxyEntry;
  usesToday: number;
  lastUsedAt: number;
  blockedUntil: number;
  active: boolean;
}

/**
 * Thứ tự ưu tiên khi mượn proxy primary. Trước đây các kind được round-robin đều
 * nhau, nhưng đo trên job backfill 2026-08-06 cho thấy hiệu quả lệch hẳn:
 * `private` (9 entry / 6 host) thắng 45/117 attempt (38%), còn `public`
 * (10 entry nhưng chỉ 2 host) thắng 1/81 (1.2%). Round-robin đều nghĩa là một
 * nửa attempt bị dội vào tier gần như chắc chắn ăn CAPTCHA, đồng thời đẩy
 * `excluded` của query đó lên đầy trước khi kịp thử hết private.
 *
 * Nay xếp hạng tường minh: chỉ rơi xuống kind sau khi kind trước đã cạn
 * (đang active hoặc còn cooldown). Trong cùng một kind, `available()` vẫn
 * least-used-first như cũ.
 */
const PRIMARY_KINDS: ProxyKind[] = ['private', 'google_public', 'public'];

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('proxy entry is empty');

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.port) throw new Error(`invalid proxy entry: ${raw}`);
    return parsed.toString().replace(/\/$/, '');
  }

  const parts = value.split(':');
  if (parts.length === 2 && parts.every(Boolean)) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 4 && parts.every(Boolean)) {
    const [host, port, username, password] = parts;
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  throw new Error(`invalid proxy entry: ${raw}`);
}

export function maskProxyUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//***@${parsed.host}`;
  } catch {
    return '[invalid-proxy]';
  }
}

export function toPlaywrightProxy(raw: string): PlaywrightProxy {
  const parsed = new URL(raw);
  const out: PlaywrightProxy = {
    server: `${parsed.protocol}//${parsed.host}`,
  };
  if (parsed.username) out.username = decodeURIComponent(parsed.username);
  if (parsed.password) out.password = decodeURIComponent(parsed.password);
  return out;
}

export function parseProxyCatalog(path: string): ProxyEntry[] {
  const sectionMap = new Map<string, ProxyKind>([
    ['proxy private', 'private'],
    ['proxy_public', 'public'],
    ['proxy public', 'public'],
    ['proxy xoay', 'rotating'],
    ['proxy_public google', 'google_public'],
    ['proxy public google', 'google_public'],
  ]);
  let currentKind: ProxyKind | undefined;
  let rotatingResetUrl = '';
  const parsedEntries: Array<Omit<ProxyEntry, 'label'>> = [];

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('###')) {
      currentKind = sectionMap.get(line.replace(/^#+/, '').trim().toLowerCase());
      continue;
    }
    if (line.startsWith('##')) {
      currentKind = undefined;
      continue;
    }
    if (!currentKind || line.startsWith('#') || line.startsWith('```')) continue;
    if (line.toLowerCase().startsWith('link reset')) {
      rotatingResetUrl = line.split('=').slice(1).join('=').trim();
      continue;
    }
    try {
      parsedEntries.push({ url: normalizeProxyUrl(line), kind: currentKind });
    } catch {
      // Ignore prose and malformed lines outside the catalog format.
    }
  }

  const seen = new Set<string>();
  const counters = new Map<ProxyKind, number>();
  const entries: ProxyEntry[] = [];
  for (const entry of parsedEntries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    const index = (counters.get(entry.kind) ?? 0) + 1;
    counters.set(entry.kind, index);
    entries.push({
      ...entry,
      label: `${entry.kind}_${index}`,
      resetUrl: entry.kind === 'rotating' && rotatingResetUrl ? rotatingResetUrl : undefined,
    });
  }
  return entries;
}

export class ProxyPool {
  private states: ProxyState[];
  private dayKey = new Date().toISOString().slice(0, 10);

  constructor(
    entries: ProxyEntry[],
    private readonly proxyConfig: RuntimeConfig['proxy'] = config.proxy,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.states = entries.map((entry) => ({
      entry,
      usesToday: 0,
      lastUsedAt: 0,
      blockedUntil: 0,
      active: false,
    }));
  }

  private resetDailyCounts(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.dayKey) return;
    this.dayKey = today;
    for (const state of this.states) state.usesToday = 0;
  }

  private available(kind: ProxyKind, excluded: ReadonlySet<string>): ProxyState[] {
    const now = Date.now();
    return this.states
      .filter(
        (state) =>
          state.entry.kind === kind &&
          !state.active &&
          state.blockedUntil <= now &&
          !excluded.has(state.entry.url),
      )
      .sort(
        (a, b) =>
          a.usesToday - b.usesToday ||
          a.lastUsedAt - b.lastUsedAt ||
          a.entry.label.localeCompare(b.entry.label),
      );
  }

  private lease(state: ProxyState): ProxyEntry {
    state.active = true;
    state.usesToday += 1;
    state.lastUsedAt = Date.now();
    return state.entry;
  }

  acquirePrimary(excluded: ReadonlySet<string> = new Set()): ProxyEntry | undefined {
    this.resetDailyCounts();
    for (const kind of PRIMARY_KINDS) {
      const candidates = this.available(kind, excluded);
      if (candidates.length > 0) return this.lease(candidates[0]);
    }
    return undefined;
  }

  /**
   * Bao lâu nữa có ít nhất 1 proxy primary hết cooldown, tính bằng ms.
   *
   * `undefined` = không proxy nào sẽ tự hồi (tất cả đang `active`, hoặc pool rỗng,
   * hoặc mọi entry đều nằm trong `excluded`) — người gọi không nên chờ.
   * `0` = đã có proxy dùng được ngay.
   *
   * Dùng để crawler chờ pool hồi thay vì bỏ query khi `acquirePrimary()` trả
   * undefined (đo 2026-08-06: 12/25 query bị bỏ vì `no_proxy`, mất dữ liệu im lặng).
   */
  msUntilPrimaryAvailable(excluded: ReadonlySet<string> = new Set()): number | undefined {
    this.resetDailyCounts();
    const now = Date.now();
    let soonest: number | undefined;
    for (const state of this.states) {
      if (!PRIMARY_KINDS.includes(state.entry.kind)) continue;
      if (state.active || excluded.has(state.entry.url)) continue;
      const waitMs = Math.max(0, state.blockedUntil - now);
      if (soonest === undefined || waitMs < soonest) soonest = waitMs;
    }
    return soonest;
  }

  acquireRotating(excluded: ReadonlySet<string> = new Set()): ProxyEntry | undefined {
    this.resetDailyCounts();
    const candidates = this.available('rotating', excluded);
    return candidates.length > 0 ? this.lease(candidates[0]) : undefined;
  }

  markSuccess(url: string): void {
    const state = this.states.find((item) => item.entry.url === url);
    if (!state) return;
    state.active = false;
    state.lastUsedAt = Date.now();
    // Một proxy vừa qua được Google vẫn có thể bị chặn ngay lượt kế nếu được cho
    // thuê lại quá nhanh (đo 2026-08-06: private_3 query_done 11:47:02 -> captcha
    // 11:48:40, và 12:32:20 -> 12:33:14). successCooldownMs cho phép ép proxy nghỉ
    // sau khi thành công; mặc định 0 = giữ nguyên hành vi cũ.
    const cooldownMs = this.proxyConfig.successCooldownMs;
    if (cooldownMs > 0) state.blockedUntil = Date.now() + cooldownMs;
  }

  release(url: string): void {
    const state = this.states.find((item) => item.entry.url === url);
    if (state) state.active = false;
  }

  markFailure(url: string): void {
    this.cooldown(url, this.proxyConfig.failureCooldownMs);
  }

  markBlocked(url: string): void {
    this.cooldown(url, this.proxyConfig.blockedCooldownMs);
  }

  private cooldown(url: string, durationMs: number): void {
    const state = this.states.find((item) => item.entry.url === url);
    if (!state) return;
    state.active = false;
    state.blockedUntil = Date.now() + durationMs;
  }

  async resetRotating(entry: ProxyEntry): Promise<void> {
    if (entry.kind !== 'rotating' || !entry.resetUrl) {
      throw new Error('rotating proxy reset URL is not configured');
    }
    const response = await this.fetchFn(entry.resetUrl, {
      signal: AbortSignal.timeout(this.proxyConfig.rotatingResetTimeoutMs),
    });
    if (!response.ok) throw new Error(`rotating proxy reset HTTP ${response.status}`);
    const state = this.states.find((item) => item.entry.url === entry.url);
    if (state) {
      state.blockedUntil = 0;
      state.active = false;
    }
    await sleep(this.proxyConfig.rotatingResetWaitMs);
  }

  /** Builds an independent G6 pool without mutating the catalog-backed pool. */
  selectProbeLabels(labels: readonly string[]): ProxyPool {
    const requested = new Set(labels);
    const entries = this.states
      .filter((state) => requested.has(state.entry.label))
      .map((state) => state.entry);
    if (entries.length !== requested.size || entries.some((entry) => entry.kind === 'rotating')) {
      throw new Error('requested probe labels are unavailable or unsupported');
    }
    return new ProxyPool(entries, this.proxyConfig, this.fetchFn);
  }

  snapshot(): Array<Record<string, string | number | boolean>> {
    this.resetDailyCounts();
    const now = Date.now();
    return this.states.map((state) => ({
      proxy: state.entry.label,
      kind: state.entry.kind,
      uses_today: state.usesToday,
      active: state.active,
      blocked: state.blockedUntil > now,
    }));
  }
}

function inferKind(tier: string, entry: string): ProxyKind {
  if (tier === 'private') return 'private';
  if (tier === 'rotating') return 'rotating';
  if (entry.includes('us01')) return 'google_public';
  return 'public';
}

async function loadProxyPoolFromDB(): Promise<ProxyPool | null> {
  const pool = new Pool({
    host: process.env.PROXY_DB_HOST || 'localhost',
    port: parseInt(process.env.PROXY_DB_PORT || '5435'),
    database: process.env.PROXY_DB_NAME || 'proxy',
    user: process.env.PROXY_DB_USER || 'admin',
    password: process.env.PROXY_DB_PASSWORD || 'admin',
    connectionTimeoutMillis: 5000,
  });

  try {
    const { rows } = await pool.query<{ entry: string; tier: string; reset_url: string | null }>(
      'SELECT entry, tier, reset_url FROM proxies ORDER BY tier, entry',
    );
    if (rows.length === 0) return null;

    const entries: ProxyEntry[] = rows.map((row, i) => ({
      url: normalizeProxyUrl(row.entry),
      kind: inferKind(row.tier, row.entry),
      label: `${inferKind(row.tier, row.entry)}_${i + 1}`,
      resetUrl: row.reset_url || undefined,
    }));

    console.log(`Loaded ${entries.length} proxies from PostgreSQL`);
    return new ProxyPool(entries);
  } catch {
    // Connection errors can contain operational endpoint details; keep runtime logs redactable.
    console.warn('Proxy DB query failed, falling back to catalog file');
    return null;
  } finally {
    await pool.end();
  }
}

export async function loadProxyPool(path?: string): Promise<ProxyPool> {
  const dbPool = await loadProxyPoolFromDB();
  if (dbPool) return dbPool;

  const filePath = path || config.proxy.catalogFile;
  console.log(`Fallback: loading proxies from ${filePath}`);
  const entries = parseProxyCatalog(filePath);
  if (entries.length === 0) throw new Error(`no proxies found in ${filePath}`);
  return new ProxyPool(entries);
}
