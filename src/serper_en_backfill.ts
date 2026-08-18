import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { getProvince } from './entity_registry';
import { buildQueries } from './query_builder';
import {
  buildSiteSearchTexts,
  extractPostId,
  isEligiblePostUrl,
  isLikelyAdResult,
  normalizeSite,
} from './platforms';
import { chunkPlaces, PlaceChunk } from './place_scheduler';
import { EN_PLACES } from './profiles/en';
import { getProfile } from './profiles';
import { CadenceGroup, PlaceEntry } from './profiles/types';

const SERPER_URL = 'https://google.serper.dev/search';
const SERPER_ROOT_URL = 'https://google.serper.dev';
const PROFILE_ID = 'en' as const;
const DEFAULT_RANGE = '2026-05-01:2026-07-31';
const DEFAULT_CHECKPOINT_FILE = './serper_backfill_checkpoint.json';
const DEFAULT_REPORT_FILE = './serper_backfill_report.json';
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_PLACES_PER_QUERY = 3;
const DEFAULT_TIERS = ['A', 'B', 'C'] as const;
const DEFAULT_SITES = ['facebook.com'];
const DEFAULT_PAGE_MAX_BY_TIER = { A: 10, B: 3, C: 1 } as const;
const DEFAULT_PAGE_FULL_THRESHOLD = 8;
const DEFAULT_CREDIT_LIMIT = 6_000;
const DEFAULT_PER_KEY_LIMIT = 2_400;
const DEFAULT_PACING_MS = 400;
const MIN_PACING_MS = 10;
const MAX_KEYS = 4;
const MAX_PAGE = 10;

type Tier = 'A' | 'B' | 'C';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

export interface BackfillConfig {
  apiKeys: string[];
  range: { dateFrom: string; dateTo: string };
  windowDays: number;
  placesPerQuery: number;
  tiers: Tier[];
  sites: string[];
  pageMaxByTier: Record<Tier, number>;
  pageFullThreshold: number;
  creditLimit: number;
  perKeyLimit: number;
  pacingMs: number;
  dryRun: boolean;
  /** Optional probe-only filters; omitted for the normal full plan. */
  onlySlugs?: string[];
  onlyWindowIndexes?: number[];
  checkpointFile: string;
  reportFile: string;
}

export interface BackfillWindow {
  index: number;
  dateFrom: string;
  dateTo: string;
  queryAfter: string;
  queryBefore: string;
}

export interface BackfillChunk {
  key: string;
  provinceSlug: string;
  cadence: CadenceGroup;
  index: number;
  tier: Tier;
  places: PlaceEntry[];
}

export interface BackfillPlanItem {
  id: string;
  site: string;
  chunk: BackfillChunk;
  intentIndex: number;
  window: BackfillWindow;
}

export interface BackfillPlan {
  profile: typeof PROFILE_ID;
  chunks: BackfillChunk[];
  windows: BackfillWindow[];
  items: BackfillPlanItem[];
  intentCount: number;
}

export interface SerperOrganicItem {
  link: string;
  title: string;
  snippet: string;
}

export interface PageStats {
  requests: number;
  credit: number;
  rawOrganic: number;
  eligible: number;
  inserted: number;
  duplicate: number;
}

export interface CheckpointEntry extends PageStats {
  status: 'pending' | 'done' | 'failed';
  itemId: string;
  page: number;
  organicCount: number;
  hasNext: boolean;
  error?: string;
  updatedAt: string;
}

export interface BackfillCheckpoint {
  version: 1;
  fingerprint: string;
  entries: Record<string, CheckpointEntry>;
  keyUsage: Record<string, number>;
  totalCredit: number;
  updatedAt: string;
}

export interface KeyUsage {
  key: string;
  usage: number;
  status: 'alive' | 'exhausted' | 'limit';
}

export interface SerperRequestRecord {
  page: number;
  key: string;
  attempt: number;
  status: number | null;
  organicCount: number;
  error?: string;
}

export interface SerperShapeAnomaly {
  page: number;
  key: string;
  status: number | null;
  reason: string;
  rawResponse: string;
}

export class BackfillStopError extends Error {
  constructor(public readonly reason: 'credit_limit' | 'no_live_keys') {
    super(reason === 'credit_limit' ? 'Serper credit limit reached' : 'No live Serper API keys remain');
    this.name = 'BackfillStopError';
  }
}

class SerperPageError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'server' | 'http' | 'response',
  ) {
    super(message);
    this.name = 'SerperPageError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function parseBoolean(raw: string | undefined, field: string, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${field} must be true or false`);
}

function parseInteger(
  raw: string | undefined,
  field: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  const values = (raw?.trim() || fallback.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function parseRange(raw: string | undefined): { dateFrom: string; dateTo: string } {
  const value = raw?.trim() || DEFAULT_RANGE;
  const parts = value.split(':');
  if (parts.length !== 2) throw new Error('BACKFILL_RANGE must be YYYY-MM-DD:YYYY-MM-DD');
  const dateFrom = parseIsoDate(parts[0], 'BACKFILL_RANGE start');
  const dateTo = parseIsoDate(parts[1], 'BACKFILL_RANGE end');
  if (dateTo < dateFrom) throw new Error('BACKFILL_RANGE end must not precede start');
  return { dateFrom, dateTo };
}

function parseTiers(raw: string | undefined): Tier[] {
  const values = parseCsv(raw, [...DEFAULT_TIERS]).map((value) => value.toUpperCase());
  if (values.length === 0 || values.some((value) => !['A', 'B', 'C'].includes(value))) {
    throw new Error('BACKFILL_TIERS must contain only A, B, C');
  }
  return Array.from(new Set(values)) as Tier[];
}

function parsePageMax(raw: string | undefined): Record<Tier, number> {
  const value =
    raw?.trim() ||
    Object.entries(DEFAULT_PAGE_MAX_BY_TIER)
      .map(([tier, max]) => `${tier}=${max}`)
      .join(',');
  const parsed: Partial<Record<Tier, number>> = {};
  for (const pair of value.split(',')) {
    const [rawTier, rawMax] = pair.split('=').map((part) => part.trim().toUpperCase());
    if (!rawTier || !rawMax || !['A', 'B', 'C'].includes(rawTier)) {
      throw new Error('BACKFILL_PAGE_MAX_BY_TIER must look like A=10,B=3,C=1');
    }
    const max = Number(rawMax);
    if (!Number.isInteger(max) || max < 1 || max > MAX_PAGE) {
      throw new Error(`BACKFILL_PAGE_MAX_BY_TIER ${rawTier} must be between 1 and ${MAX_PAGE}`);
    }
    parsed[rawTier as Tier] = max;
  }
  for (const tier of ['A', 'B', 'C'] as Tier[]) {
    if (parsed[tier] === undefined) throw new Error(`BACKFILL_PAGE_MAX_BY_TIER missing ${tier}`);
  }
  return parsed as Record<Tier, number>;
}

function parseOnlySlugs(raw: string | undefined): string[] | undefined {
  const values = parseCsv(raw, []);
  if (values.length === 0) return undefined;
  const known = new Set(EN_PLACES.map((place) => place.provinceSlug));
  const unknown = values.filter((slug) => !known.has(slug));
  if (unknown.length > 0) {
    throw new Error(`BACKFILL_ONLY_SLUGS contains unknown EN province slug(s): ${unknown.join(', ')}`);
  }
  return values;
}

function parseOnlyWindowIndexes(raw: string | undefined): number[] | undefined {
  const values = parseCsv(raw, []);
  if (values.length === 0) return undefined;
  const indexes = values.map((value) => {
    if (!/^\d+$/.test(value)) throw new Error('BACKFILL_ONLY_WINDOW_INDEXES must contain non-negative integers');
    return Number(value);
  });
  return Array.from(new Set(indexes));
}

export function validatePacingMs(value: number): number {
  if (!Number.isInteger(value) || value < MIN_PACING_MS) {
    throw new Error(`BACKFILL_PACING_MS must be an integer >= ${MIN_PACING_MS}`);
  }
  return value;
}

export function loadBackfillConfig(env: NodeJS.ProcessEnv = process.env): BackfillConfig {
  const dryRun = parseBoolean(env.DRY_RUN, 'DRY_RUN', false);
  const apiKeys = parseCsv(env.SERPER_API_KEYS, []);
  if (apiKeys.length > MAX_KEYS) throw new Error(`SERPER_API_KEYS supports at most ${MAX_KEYS} keys`);
  if (!dryRun && apiKeys.length === 0) {
    throw new Error('SERPER_API_KEYS is required for live mode; set DRY_RUN=true to plan without keys');
  }

  const sites = parseCsv(env.BACKFILL_SITES, DEFAULT_SITES).map(normalizeSite);
  const profileSites = new Set(getProfile(PROFILE_ID).sites.map(normalizeSite));
  if (sites.length === 0 || sites.some((site) => !profileSites.has(site))) {
    throw new Error(`BACKFILL_SITES must contain only ${Array.from(profileSites).join(', ')}`);
  }

  const pacingMs = validatePacingMs(
    parseInteger(env.BACKFILL_PACING_MS, 'BACKFILL_PACING_MS', DEFAULT_PACING_MS, MIN_PACING_MS),
  );
  return {
    apiKeys,
    range: parseRange(env.BACKFILL_RANGE),
    windowDays: parseInteger(env.BACKFILL_WINDOW_DAYS, 'BACKFILL_WINDOW_DAYS', DEFAULT_WINDOW_DAYS, 1),
    placesPerQuery: parseInteger(
      env.BACKFILL_PLACES_PER_QUERY,
      'BACKFILL_PLACES_PER_QUERY',
      DEFAULT_PLACES_PER_QUERY,
      1,
    ),
    tiers: parseTiers(env.BACKFILL_TIERS),
    sites,
    pageMaxByTier: parsePageMax(env.BACKFILL_PAGE_MAX_BY_TIER),
    pageFullThreshold: parseInteger(
      env.BACKFILL_PAGE_FULL_THRESHOLD,
      'BACKFILL_PAGE_FULL_THRESHOLD',
      DEFAULT_PAGE_FULL_THRESHOLD,
      1,
      100,
    ),
    creditLimit: parseInteger(env.BACKFILL_CREDIT_LIMIT, 'BACKFILL_CREDIT_LIMIT', DEFAULT_CREDIT_LIMIT, 1),
    perKeyLimit: parseInteger(
      env.BACKFILL_PER_KEY_LIMIT,
      'BACKFILL_PER_KEY_LIMIT',
      DEFAULT_PER_KEY_LIMIT,
      1,
    ),
    pacingMs,
    dryRun,
    onlySlugs: parseOnlySlugs(env.BACKFILL_ONLY_SLUGS),
    onlyWindowIndexes: parseOnlyWindowIndexes(env.BACKFILL_ONLY_WINDOW_INDEXES),
    checkpointFile: env.CHECKPOINT_FILE?.trim() || DEFAULT_CHECKPOINT_FILE,
    reportFile: DEFAULT_REPORT_FILE,
  };
}

/** Split inclusive content windows with one overlapping day at each boundary. */
export function splitBackfillRange(
  dateFrom: string,
  dateTo: string,
  windowDays: number,
): BackfillWindow[] {
  const start = parseIsoDate(dateFrom, 'dateFrom');
  const end = parseIsoDate(dateTo, 'dateTo');
  if (end < start) throw new Error('dateTo must not precede dateFrom');
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error('windowDays must be a positive integer');
  }

  const windows: BackfillWindow[] = [];
  let current = start;
  while (current <= end) {
    const candidateEnd = addDays(current, windowDays - 1);
    const actualEnd = candidateEnd < end ? candidateEnd : end;
    windows.push({
      index: windows.length,
      dateFrom: current,
      dateTo: actualEnd,
      queryAfter: addDays(current, -1),
      queryBefore: addDays(actualEnd, 1),
    });
    if (actualEnd === end) break;
    const next = actualEnd;
    current = next > current ? next : addDays(current, 1);
  }
  return windows;
}

function toBackfillChunk(chunk: PlaceChunk): BackfillChunk {
  const province = getProvince(chunk.provinceSlug);
  if (!province) throw new Error(`Profile place has unknown province slug: ${chunk.provinceSlug}`);
  return { ...chunk, tier: province.tier };
}

export function buildBackfillPlan(config: BackfillConfig): BackfillPlan {
  const selectedPlaces = EN_PLACES.filter((place) => {
    const province = getProvince(place.provinceSlug);
    return (
      Boolean(province) &&
      config.tiers.includes(province!.tier) &&
      (!config.onlySlugs || config.onlySlugs.includes(place.provinceSlug))
    );
  });
  const chunks = chunkPlaces(selectedPlaces, config.placesPerQuery)
    .map(toBackfillChunk)
    .filter((chunk) => config.tiers.includes(chunk.tier));
  const allWindows = splitBackfillRange(config.range.dateFrom, config.range.dateTo, config.windowDays);
  const windows = config.onlyWindowIndexes
    ? allWindows.filter((window) => config.onlyWindowIndexes!.includes(window.index))
    : allWindows;
  if (windows.length === 0) throw new Error('BACKFILL_ONLY_WINDOW_INDEXES selected no windows');
  const intentCount = getProfile(PROFILE_ID).intentGroups?.length ?? 0;
  if (intentCount === 0) throw new Error('Profile en has no intent groups');

  const items: BackfillPlanItem[] = [];
  for (const window of windows) {
    for (const chunk of chunks) {
      for (let intentIndex = 0; intentIndex < intentCount; intentIndex++) {
        items.push({
          id: `${chunk.key}|intent=${intentIndex}|window=${window.index}`,
          site: config.sites[0],
          chunk,
          intentIndex,
          window,
        });
      }
    }
  }
  const tierOrder: Record<Tier, number> = { A: 0, B: 1, C: 2 };
  items.sort(
    (left, right) =>
      tierOrder[left.chunk.tier] - tierOrder[right.chunk.tier] ||
      left.window.index - right.window.index ||
      left.chunk.key.localeCompare(right.chunk.key) ||
      left.intentIndex - right.intentIndex,
  );
  // Validate every planned body before opening a database connection or making a request.
  // This turns a production-builder shape change into an immediate, explicit stop.
  for (const item of items) buildBackfillQuery(item.site, item.chunk, item.intentIndex, item.window);
  return { profile: PROFILE_ID, chunks, windows, items, intentCount };
}

/** Build the exact production query for one chunk/intent, with only dates supplied by the backfill window. */
export function buildBackfillQuery(
  site: string,
  chunk: BackfillChunk,
  intentIndex: number,
  window: BackfillWindow,
): string {
  const bodies = buildSiteSearchTexts(site, chunk.provinceSlug, PROFILE_ID, chunk.places);
  const expectedIntentCount = getProfile(PROFILE_ID).intentGroups?.length ?? 0;
  if (bodies.length !== expectedIntentCount) {
    throw new Error(
      `Production builder changed chunk shape for ${chunk.key}: expected ${expectedIntentCount} bodies, got ${bodies.length}`,
    );
  }
  const body = bodies[intentIndex];
  if (!body) throw new Error(`No production body for ${chunk.key} intent=${intentIndex}`);
  const built = buildQueries(
    [site],
    body,
    window.dateFrom,
    window.dateTo,
    0,
    'custom',
    'bounded',
  );
  if (built.length !== 1) throw new Error(`Expected one bounded query, got ${built.length}`);
  return built[0].query;
}

export function adaptiveHasNextPage(
  organicCount: number,
  page: number,
  pageMax: number,
  fullThreshold: number,
): boolean {
  return organicCount >= fullThreshold && page < pageMax;
}

export function parseSerperOrganic(payload: unknown): SerperOrganicItem[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { organic?: unknown }).organic)) {
    return [];
  }
  return (payload as { organic: unknown[] }).organic.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { link?: unknown; title?: unknown; snippet?: unknown };
    if (typeof value.link !== 'string' || !value.link.trim()) return [];
    return [{
      link: value.link.trim(),
      title: typeof value.title === 'string' ? value.title : '',
      snippet: typeof value.snippet === 'string' ? value.snippet : '',
    }];
  });
}

interface KeyState {
  raw: string;
  label: string;
  usage: number;
  status: 'alive' | 'exhausted' | 'limit';
}

export function selectNextKey(states: KeyState[], cursor: number): { state: KeyState; nextCursor: number } | null {
  if (states.length === 0) return null;
  for (let offset = 0; offset < states.length; offset++) {
    const index = (cursor + offset) % states.length;
    const state = states[index];
    if (state.status === 'alive') return { state, nextCursor: (index + 1) % states.length };
  }
  return null;
}

export class SerperKeyPool {
  private readonly states: KeyState[];
  private cursor = 0;
  private total = 0;

  constructor(
    keys: string[],
    private readonly perKeyLimit: number,
    private readonly creditLimit: number,
    initialUsage: Record<string, number> = {},
  ) {
    this.states = keys.map((raw, index) => {
      const usage = initialUsage[String(index + 1)] ?? 0;
      return {
        raw,
        label: `key_${index + 1}`,
        usage,
        status: usage >= perKeyLimit ? 'limit' : 'alive',
      };
    });
    this.total = this.states.reduce((sum, state) => sum + state.usage, 0);
  }

  get totalCredit(): number {
    return this.total;
  }

  get hasLiveKeys(): boolean {
    return this.states.some((state) => state.status === 'alive');
  }

  acquire(): KeyState {
    if (this.total >= this.creditLimit) throw new BackfillStopError('credit_limit');
    const next = selectNextKey(this.states, this.cursor);
    if (!next) throw new BackfillStopError('no_live_keys');
    this.cursor = next.nextCursor;
    return next.state;
  }

  recordRequest(state: KeyState): void {
    if (this.total >= this.creditLimit) throw new BackfillStopError('credit_limit');
    state.usage += 1;
    this.total += 1;
    if (state.usage >= this.perKeyLimit) state.status = 'limit';
  }

  markExhausted(state: KeyState): void {
    state.status = 'exhausted';
  }

  snapshot(): { totalCredit: number; keys: KeyUsage[] } {
    return {
      totalCredit: this.total,
      keys: this.states.map(({ label, usage, status }) => ({ key: label, usage, status })),
    };
  }

  usageByIndex(): Record<string, number> {
    return Object.fromEntries(this.states.map((state) => [state.label.replace('key_', ''), state.usage]));
  }
}

export class CheckpointStore {
  private readonly state: BackfillCheckpoint;

  private constructor(
    private readonly file: string,
    private readonly enabled: boolean,
    state: BackfillCheckpoint,
  ) {
    this.state = state;
  }

  static async open(
    file: string,
    fingerprint: string,
    enabled: boolean,
    acceptedLegacyFingerprints: string[] = [],
  ): Promise<CheckpointStore> {
    const empty: BackfillCheckpoint = {
      version: 1,
      fingerprint,
      entries: {},
      keyUsage: {},
      totalCredit: 0,
      updatedAt: new Date().toISOString(),
    };
    if (!enabled) return new CheckpointStore(file, false, empty);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<BackfillCheckpoint>;
      const fingerprintAccepted = raw.fingerprint === fingerprint || acceptedLegacyFingerprints.includes(raw.fingerprint ?? '');
      if (raw.version !== 1 || !fingerprintAccepted || !raw.entries) {
        throw new Error('checkpoint fingerprint/version does not match this plan');
      }
      return new CheckpointStore(file, true, {
        version: 1,
        fingerprint,
        entries: raw.entries as Record<string, CheckpointEntry>,
        keyUsage: raw.keyUsage ?? {},
        totalCredit: raw.totalCredit ?? 0,
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new CheckpointStore(file, true, empty);
      }
      throw error;
    }
  }

  get entries(): Readonly<Record<string, CheckpointEntry>> {
    return this.state.entries;
  }

  get doneCount(): number {
    return Object.values(this.state.entries).filter((entry) => entry.status === 'done').length;
  }

  get keyUsage(): Record<string, number> {
    return { ...this.state.keyUsage };
  }

  setUsage(totalCredit: number, keyUsage: Record<string, number>): void {
    this.state.totalCredit = totalCredit;
    this.state.keyUsage = { ...keyUsage };
    this.state.updatedAt = new Date().toISOString();
  }

  async markPending(key: string, itemId: string, page: number): Promise<void> {
    this.state.entries[key] = {
      itemId,
      page,
      status: 'pending',
      requests: 0,
      credit: 0,
      rawOrganic: 0,
      eligible: 0,
      inserted: 0,
      duplicate: 0,
      organicCount: 0,
      hasNext: false,
      updatedAt: new Date().toISOString(),
    };
    await this.flush();
  }

  async markDone(key: string, entry: Omit<CheckpointEntry, 'status' | 'updatedAt'>): Promise<void> {
    this.state.entries[key] = { ...entry, status: 'done', updatedAt: new Date().toISOString() };
    await this.flush();
  }

  async markFailed(
    key: string,
    entry: Omit<CheckpointEntry, 'status' | 'updatedAt'>,
    error: string,
  ): Promise<void> {
    this.state.entries[key] = {
      ...entry,
      status: 'failed',
      error,
      updatedAt: new Date().toISOString(),
    };
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    this.state.updatedAt = new Date().toISOString();
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}

function fingerprint(config: BackfillConfig, plan: BackfillPlan, includeOperationalLimits: boolean): string {
  const value = {
    profile: plan.profile,
    range: config.range,
    windowDays: config.windowDays,
    placesPerQuery: config.placesPerQuery,
    tiers: config.tiers,
    sites: config.sites,
    ...(includeOperationalLimits
      ? { pageMaxByTier: config.pageMaxByTier, pageFullThreshold: config.pageFullThreshold }
      : {}),
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Stable plan identity excludes probe/full-run paging limits so a probe can resume into a full run. */
export function planFingerprint(config: BackfillConfig, plan: BackfillPlan): string {
  return fingerprint(config, plan, false);
}

function legacyPlanFingerprint(config: BackfillConfig, plan: BackfillPlan): string {
  return fingerprint(config, plan, true);
}

class PacingGate {
  private lastRequestAt: number | null = null;

  constructor(private readonly pacingMs: number, private readonly now: () => number, private readonly wait: SleepLike) {}

  async beforeRequest(): Promise<void> {
    if (this.lastRequestAt !== null) {
      const remaining = this.pacingMs - (this.now() - this.lastRequestAt);
      if (remaining > 0) await this.wait(remaining);
    }
    this.lastRequestAt = this.now();
  }
}

interface SearchPageResult {
  organic: SerperOrganicItem[];
  stats: PageStats;
  requests: SerperRequestRecord[];
  shapeAnomaly?: SerperShapeAnomaly;
  error?: string;
}

interface KeyRequestResult {
  organic: SerperOrganicItem[];
  stats: PageStats;
  requests: SerperRequestRecord[];
  shapeAnomaly?: SerperShapeAnomaly;
  error?: Error;
  exhaustedStatus?: number;
}

const EXPECTED_SERPER_ORGANIC_KEYS = new Set([
  'position',
  'title',
  'link',
  'snippet',
  'date',
  'source',
  'sitelinks',
  'thumbnail',
]);

function inspectSerperShape(payload: unknown, rawResponse: string): { reason: string; rawResponse: string } | undefined {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { organic?: unknown }).organic)) {
    return { reason: 'missing_or_non_array_organic', rawResponse };
  }
  const organic = (payload as { organic: unknown[] }).organic;
  for (const item of organic) {
    if (!item || typeof item !== 'object') return { reason: 'organic_item_not_object', rawResponse };
    const unknownKeys = Object.keys(item).filter((key) => !EXPECTED_SERPER_ORGANIC_KEYS.has(key));
    if (unknownKeys.length > 0) return { reason: `unexpected_organic_fields:${unknownKeys.join(',')}`, rawResponse };
  }
  return undefined;
}

function emptyPageStats(): PageStats {
  return { requests: 0, credit: 0, rawOrganic: 0, eligible: 0, inserted: 0, duplicate: 0 };
}

function addPageStats(left: PageStats, right: PageStats): PageStats {
  return {
    requests: left.requests + right.requests,
    credit: left.credit + right.credit,
    rawOrganic: left.rawOrganic + right.rawOrganic,
    eligible: left.eligible + right.eligible,
    inserted: left.inserted + right.inserted,
    duplicate: left.duplicate + right.duplicate,
  };
}

export interface SerperClientOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  now?: () => number;
  onRequest?: (keyLabel: string, pool: SerperKeyPool) => Promise<void>;
}

export class SerperClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: SleepLike;
  private readonly pacing: PacingGate;

  constructor(
    private readonly pool: SerperKeyPool,
    pacingMs: number,
    options: SerperClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.pacing = new PacingGate(pacingMs, options.now ?? Date.now, this.sleepImpl);
    this.onRequest = options.onRequest;
  }

  private readonly onRequest?: (keyLabel: string, pool: SerperKeyPool) => Promise<void>;

  get totalCredit(): number {
    return this.pool.totalCredit;
  }

  usageByIndex(): Record<string, number> {
    return this.pool.usageByIndex();
  }

  async search(query: string, page: number): Promise<SearchPageResult> {
    let alternateKeyUsed = false;
    let combinedStats = emptyPageStats();
    const combinedRequests: SerperRequestRecord[] = [];
    let shapeAnomaly: SerperShapeAnomaly | undefined;
    while (true) {
      const key = this.pool.acquire();
      const result = await this.requestWithKey(key, query, page);
      combinedStats = addPageStats(combinedStats, result.stats);
      combinedRequests.push(...result.requests);
      shapeAnomaly ??= result.shapeAnomaly;
      if (result.exhaustedStatus !== undefined) {
        this.pool.markExhausted(key);
        if (!alternateKeyUsed && this.pool.hasLiveKeys) {
          alternateKeyUsed = true;
          continue;
        }
        throw new BackfillStopError('no_live_keys');
      }
      return {
        organic: result.organic,
        stats: combinedStats,
        requests: combinedRequests,
        shapeAnomaly,
        error: result.error?.message,
      };
    }
  }

  private async requestWithKey(
    key: KeyState,
    query: string,
    page: number,
  ): Promise<KeyRequestResult> {
    let requests = 0;
    const requestRecords: SerperRequestRecord[] = [];
    for (let attempt = 0; attempt <= 2; attempt++) {
      await this.pacing.beforeRequest();
      this.pool.recordRequest(key);
      requests += 1;
      if (this.onRequest) await this.onRequest(key.label, this.pool);

      let response: Response;
      try {
        response = await this.fetchImpl(SERPER_URL, {
          method: 'POST',
          headers: { 'X-API-KEY': key.raw, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', page }),
        });
      } catch (error) {
        requestRecords.push({
          page,
          key: key.label,
          attempt: attempt + 1,
          status: null,
          organicCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < 2) {
          await this.sleepImpl(attempt === 0 ? 1_000 : 3_000);
          continue;
        }
        return {
          organic: [],
          stats: { ...emptyPageStats(), requests, credit: requests },
          requests: requestRecords,
          error: new SerperPageError(error instanceof Error ? error.message : String(error), 'network'),
        };
      }

      if (response.status === 429 || response.status === 402 || response.status === 403) {
        requestRecords.push({ page, key: key.label, attempt: attempt + 1, status: response.status, organicCount: 0 });
        return {
          organic: [],
          stats: { ...emptyPageStats(), requests, credit: requests },
          requests: requestRecords,
          exhaustedStatus: response.status,
        };
      }
      if (response.status >= 500 && response.status <= 599) {
        requestRecords.push({ page, key: key.label, attempt: attempt + 1, status: response.status, organicCount: 0 });
        if (attempt < 2) {
          await this.sleepImpl(attempt === 0 ? 1_000 : 3_000);
          continue;
        }
        return {
          organic: [],
          stats: { ...emptyPageStats(), requests, credit: requests },
          requests: requestRecords,
          error: new SerperPageError(`HTTP ${response.status}`, 'server'),
        };
      }
      if (!response.ok) {
        requestRecords.push({ page, key: key.label, attempt: attempt + 1, status: response.status, organicCount: 0 });
        return {
          organic: [],
          stats: { ...emptyPageStats(), requests, credit: requests },
          requests: requestRecords,
          error: new SerperPageError(`HTTP ${response.status}`, 'http'),
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        requestRecords.push({
          page,
          key: key.label,
          attempt: attempt + 1,
          status: response.status,
          organicCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          organic: [],
          stats: { ...emptyPageStats(), requests, credit: requests },
          requests: requestRecords,
          error: new SerperPageError(error instanceof Error ? error.message : String(error), 'response'),
        };
      }
      const rawResponse = JSON.stringify(payload);
      const organic = parseSerperOrganic(payload);
      const record = {
        page,
        key: key.label,
        attempt: attempt + 1,
        status: response.status,
        organicCount: organic.length,
      };
      requestRecords.push(record);
      const shape = inspectSerperShape(payload, rawResponse);
      return {
        organic,
        stats: { ...emptyPageStats(), requests, credit: requests },
        requests: requestRecords,
        shapeAnomaly: shape
          ? { page, key: key.label, status: response.status, ...shape }
          : undefined,
      };
    }
    return {
      organic: [],
      stats: { ...emptyPageStats(), requests, credit: requests },
      requests: requestRecords,
      error: new SerperPageError('request exhausted retries', 'network'),
    };
  }
}

interface ReportRow extends PageStats {
  tier: Tier;
  provinceSlug: string;
  windowIndex: number;
  dateFrom: string;
  dateTo: string;
}

class ReportAccumulator {
  private readonly rows = new Map<string, ReportRow>();
  private readonly fullThreshold: number;
  readonly requests: (SerperRequestRecord & {
    itemId: string;
    tier: Tier;
    provinceSlug: string;
    windowIndex: number;
  })[] = [];
  readonly shapeAnomalies: (SerperShapeAnomaly & { itemId: string })[] = [];
  readonly insertedUrlCandidates: { itemId: string; postId: string; url: string }[] = [];
  pageCount = 0;
  pageFullCount = 0;
  readonly failed: { itemId: string; error: string }[] = [];
  readonly skipped: { itemId: string; reason: string }[] = [];

  constructor(fullThreshold: number) {
    this.fullThreshold = fullThreshold;
  }

  add(item: BackfillPlanItem, stats: PageStats): void {
    this.pageCount += 1;
    if (stats.rawOrganic >= this.fullThreshold) this.pageFullCount += 1;
    const key = `${item.chunk.tier}|${item.chunk.provinceSlug}|${item.window.index}`;
    const current = this.rows.get(key) ?? {
      tier: item.chunk.tier,
      provinceSlug: item.chunk.provinceSlug,
      windowIndex: item.window.index,
      dateFrom: item.window.dateFrom,
      dateTo: item.window.dateTo,
      requests: 0,
      credit: 0,
      rawOrganic: 0,
      eligible: 0,
      inserted: 0,
      duplicate: 0,
    };
    for (const field of ['requests', 'credit', 'rawOrganic', 'eligible', 'inserted', 'duplicate'] as const) {
      current[field] += stats[field];
    }
    this.rows.set(key, current);
  }

  addRequests(item: BackfillPlanItem, requests: SerperRequestRecord[]): void {
    for (const request of requests) {
      const entry = { ...request, itemId: item.id, tier: item.chunk.tier, provinceSlug: item.chunk.provinceSlug, windowIndex: item.window.index };
      this.requests.push(entry);
      console.log(`[serper_request] ${JSON.stringify(entry)}`);
    }
  }

  addShapeAnomaly(item: BackfillPlanItem, anomaly: SerperShapeAnomaly | undefined): void {
    if (!anomaly) return;
    const entry = { ...anomaly, itemId: item.id };
    this.shapeAnomalies.push(entry);
    console.warn(`[serper_shape_anomaly] ${JSON.stringify(entry)}`);
  }

  addInsertedCandidates(
    item: BackfillPlanItem,
    posts: { postId: string; url: string }[],
    inserted: number,
  ): void {
    const remaining = Math.max(0, 3 - this.insertedUrlCandidates.length);
    for (const post of posts.slice(0, Math.min(inserted, remaining))) {
      this.insertedUrlCandidates.push({ itemId: item.id, ...post });
    }
  }

  totals(): PageStats {
    return this.toRows().reduce(
      (total, row) => addPageStats(total, row),
      emptyPageStats(),
    );
  }

  toRows(): ReportRow[] {
    return Array.from(this.rows.values()).sort(
      (a, b) => a.windowIndex - b.windowIndex || a.tier.localeCompare(b.tier) || a.provinceSlug.localeCompare(b.provinceSlug),
    );
  }
}

function checkpointStatsForPlan(
  plan: BackfillPlan,
  entries: Readonly<Record<string, CheckpointEntry>>,
): PageStats {
  const planItemIds = new Set(plan.items.map((item) => item.id));
  return Object.values(entries)
    .filter((entry) => entry.status === 'done' && planItemIds.has(entry.itemId))
    .reduce((total, entry) => addPageStats(total, entry), emptyPageStats());
}

function checkpointPageContinuationForPlan(
  plan: BackfillPlan,
  entries: Readonly<Record<string, CheckpointEntry>>,
  fullThreshold: number,
): { fullPages: number; pages: number; rate: number | null; threshold: number } {
  const planItemIds = new Set(plan.items.map((item) => item.id));
  const done = Object.values(entries).filter(
    (entry) => entry.status === 'done' && planItemIds.has(entry.itemId),
  );
  const fullPages = done.filter((entry) => entry.rawOrganic >= fullThreshold).length;
  return {
    fullPages,
    pages: done.length,
    rate: done.length > 0 ? fullPages / done.length : null,
    threshold: fullThreshold,
  };
}

interface RemainingPlanSummary {
  total: number;
  byTier: Record<Tier, number>;
  unstartedByTier: Record<Tier, number>;
  cappedByTier: Record<Tier, number>;
}

function summarizeRemainingPlan(
  plan: BackfillPlan,
  config: BackfillConfig,
  entries: Readonly<Record<string, CheckpointEntry>>,
): RemainingPlanSummary {
  const summary: RemainingPlanSummary = {
    total: 0,
    byTier: { A: 0, B: 0, C: 0 },
    unstartedByTier: { A: 0, B: 0, C: 0 },
    cappedByTier: { A: 0, B: 0, C: 0 },
  };
  for (const item of plan.items) {
    const pageMax = config.pageMaxByTier[item.chunk.tier];
    let page = 1;
    let started = false;
    let terminal = false;
    while (page <= pageMax) {
      const entry = entries[pageCheckpointKey(item, page)];
      if (!entry || entry.status !== 'done') break;
      started = true;
      if (!entry.hasNext) {
        terminal = true;
        break;
      }
      page += 1;
    }
    const capped = started && !terminal && page > pageMax;
    if (!terminal) {
      summary.total += 1;
      summary.byTier[item.chunk.tier] += 1;
      if (!started) summary.unstartedByTier[item.chunk.tier] += 1;
      if (capped) summary.cappedByTier[item.chunk.tier] += 1;
    }
  }
  return summary;
}

interface DbContext {
  db: typeof import('./db');
  keywordByProvince: Map<string, number>;
  runBySiteWindow: Map<string, string>;
}

async function openDbContext(plan: BackfillPlan, sites: string[]): Promise<DbContext> {
  const db = await import('./db');
  await db.loadPlatformCache();
  const rows = (await db.getAllKeywords()) as { keyword_id: number; province: string }[];
  const keywordByProvince = new Map<string, number>();
  for (const row of rows) {
    if (!keywordByProvince.has(row.province)) keywordByProvince.set(row.province, row.keyword_id);
  }
  const runBySiteWindow = new Map<string, string>();
  for (const window of plan.windows) {
    const start = new Date(`${window.dateFrom}T00:00:00+07:00`);
    const end = new Date(`${window.dateTo}T23:59:59+07:00`);
    for (const site of sites) {
      const platformId = db.resolvePlatformId(site);
      const runId = await db.createCrawlRun(platformId, 'backfill', start, end);
      runBySiteWindow.set(`${site}|${window.index}`, runId);
    }
  }
  return { db, keywordByProvince, runBySiteWindow };
}

function pageCheckpointKey(item: BackfillPlanItem, page: number): string {
  return `${item.id}|page=${page}`;
}

async function processItem(
  item: BackfillPlanItem,
  config: BackfillConfig,
  client: SerperClient,
  checkpoint: CheckpointStore,
  report: ReportAccumulator,
  dbContext: DbContext,
): Promise<'done' | 'failed' | 'stopped'> {
  const keywordId = dbContext.keywordByProvince.get(item.chunk.provinceSlug);
  if (!keywordId) {
    const reason = `provinceSlug ${item.chunk.provinceSlug} is missing from dim_keyword`;
    console.warn(`[serper_backfill] warning: ${reason}; item=${item.id}`);
    report.skipped.push({ itemId: item.id, reason });
    return 'failed';
  }

  const runId = dbContext.runBySiteWindow.get(`${item.site}|${item.window.index}`);
  if (!runId) throw new Error(`Missing crawl run for ${item.site}|${item.window.index}`);
  const pageMax = config.pageMaxByTier[item.chunk.tier];
  let page = 1;

  while (page <= pageMax) {
    const checkpointKey = pageCheckpointKey(item, page);
    const previous = checkpoint.entries[checkpointKey];
    if (previous?.status === 'done') {
      report.add(item, previous);
      if (!previous.hasNext) return 'done';
      page += 1;
      continue;
    }

    await checkpoint.markPending(checkpointKey, item.id, page);
    const query = buildBackfillQuery(item.site, item.chunk, item.intentIndex, item.window);
    let fetched: SearchPageResult;
    try {
      fetched = await client.search(query, page);
      report.addRequests(item, fetched.requests);
      report.addShapeAnomaly(item, fetched.shapeAnomaly);
      checkpoint.setUsage(client.totalCredit, client.usageByIndex());
      await checkpoint.flush();
    } catch (error) {
      checkpoint.setUsage(client.totalCredit, client.usageByIndex());
      await checkpoint.flush();
      if (error instanceof BackfillStopError) return 'stopped';
      const message = error instanceof Error ? error.message : String(error);
      await checkpoint.markFailed(checkpointKey, {
        itemId: item.id,
        page,
        requests: 0,
        credit: 0,
        rawOrganic: 0,
        eligible: 0,
        inserted: 0,
        duplicate: 0,
        organicCount: 0,
        hasNext: false,
      }, message);
      report.failed.push({ itemId: item.id, error: message });
      return 'failed';
    }

    const pageStats: PageStats = { ...fetched.stats, rawOrganic: fetched.organic.length, eligible: 0, inserted: 0, duplicate: 0 };
    if (fetched.error) {
      await checkpoint.markFailed(checkpointKey, {
        itemId: item.id,
        page,
        ...pageStats,
        organicCount: 0,
        hasNext: false,
      }, fetched.error);
      report.add(item, pageStats);
      report.failed.push({ itemId: item.id, error: fetched.error });
      return 'failed';
    }

    const validPosts: { postId: string; url: string }[] = [];
    for (const result of fetched.organic) {
      if (isLikelyAdResult(result.title, result.snippet)) continue;
      const postId = extractPostId(result.link, item.site);
      if (!postId || !isEligiblePostUrl(result.link, item.site)) continue;
      validPosts.push({ postId, url: result.link });
    }
    pageStats.eligible = validPosts.length;
    try {
      pageStats.inserted = await dbContext.db.insertPosts(
        validPosts,
        dbContext.db.resolvePlatformId(item.site),
        keywordId,
        runId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await checkpoint.markFailed(checkpointKey, {
        itemId: item.id,
        page,
        ...pageStats,
        organicCount: fetched.organic.length,
        hasNext: false,
      }, message);
      report.add(item, pageStats);
      report.failed.push({ itemId: item.id, error: message });
      return 'failed';
    }
    pageStats.duplicate = pageStats.eligible - pageStats.inserted;
    report.addInsertedCandidates(item, validPosts, pageStats.inserted);
    const hasNext = adaptiveHasNextPage(
      fetched.organic.length,
      page,
      pageMax,
      config.pageFullThreshold,
    );
    await checkpoint.markDone(checkpointKey, {
      itemId: item.id,
      page,
      ...pageStats,
      organicCount: fetched.organic.length,
      hasNext,
    });
    report.add(item, pageStats);
    if (!hasNext) return 'done';
    page += 1;
  }
  return 'done';
}

function safeConfig(config: BackfillConfig): Record<string, unknown> {
  return {
    profile: PROFILE_ID,
    serper_api_keys: config.apiKeys.length,
    backfill_range: `${config.range.dateFrom}:${config.range.dateTo}`,
    backfill_window_days: config.windowDays,
    backfill_places_per_query: config.placesPerQuery,
    backfill_tiers: config.tiers,
    backfill_sites: config.sites,
    backfill_page_max_by_tier: config.pageMaxByTier,
    backfill_page_full_threshold: config.pageFullThreshold,
    backfill_credit_limit: config.creditLimit,
    backfill_per_key_limit: config.perKeyLimit,
    backfill_pacing_ms: config.pacingMs,
    dry_run: config.dryRun,
    backfill_only_slugs: config.onlySlugs ?? null,
    backfill_only_window_indexes: config.onlyWindowIndexes ?? null,
    checkpoint_file: config.checkpointFile,
    report_file: config.reportFile,
  };
}

function sampleQueries(plan: BackfillPlan): Record<string, unknown>[] {
  const samples: Record<string, unknown>[] = [];
  const fallbackChunks = chunkPlaces(EN_PLACES, DEFAULT_PLACES_PER_QUERY).map(toBackfillChunk);
  const preferred = [
    plan.chunks.find((chunk) => chunk.provinceSlug === 'da_nang' && chunk.tier === 'A'),
    plan.chunks.find((chunk) => chunk.tier === 'C') ?? fallbackChunks.find((chunk) => chunk.tier === 'C'),
  ];
  for (const chunk of preferred) {
    if (!chunk) continue;
    const window = plan.windows[0];
    const body = buildSiteSearchTexts('facebook.com', chunk.provinceSlug, PROFILE_ID, chunk.places)[0];
    const query = buildBackfillQuery('facebook.com', chunk, 0, window);
    const productionWindow = splitBackfillRange('2026-08-01', '2026-08-14', 14)[0];
    const productionQuery = buildQueries(
      ['facebook.com'],
      body,
      productionWindow.dateFrom,
      productionWindow.dateTo,
      0,
      'custom',
      'bounded',
    )[0].query;
    const withoutDates = (value: string) => value.replace(/\s+after:\S+\s+before:\S+$/, '');
    samples.push({
      tier: chunk.tier,
      provinceSlug: chunk.provinceSlug,
      chunkKey: chunk.key,
      places: chunk.places.map((place) => place.name),
      productionBody: body,
      productionQuery,
      backfillQuery: query,
      onlyDateOperatorsDiffer: withoutDates(productionQuery) === withoutDates(query),
    });
  }
  return samples;
}

async function checkSerperReachable(fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<Record<string, unknown>> {
  try {
    const response = await fetchImpl(SERPER_ROOT_URL, { method: 'HEAD', redirect: 'manual' });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeReport(file: string, report: Record<string, unknown>): Promise<void> {
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function runDryRun(config: BackfillConfig, plan: BackfillPlan): Promise<void> {
  const minCredit = plan.items.length;
  const maxCredit = plan.items.reduce((sum, item) => sum + config.pageMaxByTier[item.chunk.tier], 0);
  const tierCounts = Object.fromEntries(
    (['A', 'B', 'C'] as Tier[]).map((tier) => [
      tier,
      {
        chunks: plan.chunks.filter((chunk) => chunk.tier === tier).length,
        queryGroups: plan.items.filter((item) => item.chunk.tier === tier).length,
        requestMax: plan.items
          .filter((item) => item.chunk.tier === tier)
          .reduce((sum, item) => sum + config.pageMaxByTier[item.chunk.tier], 0),
      },
    ]),
  );
  const report = {
    mode: 'DRY_RUN',
    config: safeConfig(config),
    plan: {
      chunks: plan.chunks.length,
      windows: plan.windows.length,
      intentGroups: plan.intentCount,
      items: plan.items.length,
      expectedFormula: `${plan.chunks.length} chunks x ${plan.intentCount} intent groups x ${plan.windows.length} windows`,
      expectedPromptEstimate: '~2142 assumes 102 chunks; current chunkPlaces returns 136 cadence-separated chunks',
      planWarning:
        config.onlySlugs || config.onlyWindowIndexes
          ? 'Probe-only plan filters are active; production query and paging logic are unchanged.'
          : plan.items.length !== 2_142
            ? 'No estimate-driven filtering was applied; all EN_PLACES in the selected tiers remain in the plan.'
            : undefined,
      creditEstimate: { min: minCredit, maxAdaptive: maxCredit },
      tierCounts,
    },
    querySamples: sampleQueries(plan),
    serperRoot: await checkSerperReachable(),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function runLive(config: BackfillConfig, plan: BackfillPlan): Promise<void> {
  const startedAt = Date.now();
  const fingerprint = planFingerprint(config, plan);
  const checkpoint = await CheckpointStore.open(
    config.checkpointFile,
    fingerprint,
    true,
    [
      legacyPlanFingerprint(config, plan),
      legacyPlanFingerprint(
        { ...config, pageMaxByTier: { ...DEFAULT_PAGE_MAX_BY_TIER } },
        plan,
      ),
    ],
  );
  if (checkpoint.doneCount > 0) {
    console.log(`[serper_backfill] resume từ checkpoint: ${checkpoint.doneCount} mục đã xong`);
  }

  const dbContext = await openDbContext(plan, config.sites);
  const pool = new SerperKeyPool(
    config.apiKeys,
    config.perKeyLimit,
    config.creditLimit,
    checkpoint.keyUsage,
  );
  const report = new ReportAccumulator(config.pageFullThreshold);
  const client = new SerperClient(pool, config.pacingMs, {
    onRequest: async () => {
      checkpoint.setUsage(pool.totalCredit, pool.usageByIndex());
      await checkpoint.flush();
    },
  });
  let stopped = false;

  try {
    for (const item of plan.items) {
      const result = await processItem(item, config, client, checkpoint, report, dbContext);
      if (result === 'stopped') {
        stopped = true;
        break;
      }
    }
  } finally {
    checkpoint.setUsage(pool.totalCredit, pool.usageByIndex());
    await checkpoint.flush();
    for (const window of plan.windows) {
      for (const site of config.sites) {
        const runId = dbContext.runBySiteWindow.get(`${site}|${window.index}`);
        if (!runId) continue;
        const rowStats = report.toRows().filter((row) => row.windowIndex === window.index);
        const totalRaw = rowStats.reduce((sum, row) => sum + row.rawOrganic, 0);
        const totalInserted = rowStats.reduce((sum, row) => sum + row.inserted, 0);
        const windowFailed = [...report.failed, ...report.skipped].some((failure) => {
          const item = plan.items.find((candidate) => candidate.id === failure.itemId);
          return item?.window.index === window.index;
        });
        await dbContext.db.completeCrawlRun(
          runId,
          { totalUrlsDiscovered: totalRaw, totalUrlsScraped: totalInserted },
          !stopped && !windowFailed,
        );
      }
    }
    await dbContext.db.closeDb();
  }

  const completedPages = Object.values(checkpoint.entries).filter((entry) => entry.status === 'done').length;
  const executionTotals = report.totals();
  const checkpointTotals = checkpointStatsForPlan(plan, checkpoint.entries);
  const checkpointPageContinuationRate = checkpointPageContinuationForPlan(
    plan,
    checkpoint.entries,
    config.pageFullThreshold,
  );
  const remaining = summarizeRemainingPlan(plan, config, checkpoint.entries);
  const finalReport = {
    mode: 'LIVE',
    config: safeConfig(config),
    plan: { chunks: plan.chunks.length, windows: plan.windows.length, intentGroups: plan.intentCount, items: plan.items.length },
    rows: report.toRows(),
    requestTelemetry: report.requests,
    pageContinuationRate: {
      fullPages: report.pageFullCount,
      pages: report.pageCount,
      rate: report.pageCount > 0 ? report.pageFullCount / report.pageCount : null,
      threshold: config.pageFullThreshold,
    },
    checkpointPageContinuationRate,
    eligibility: (() => {
      const totals = checkpointTotals;
      return {
        rawOrganic: totals.rawOrganic,
        eligible: totals.eligible,
        rate: totals.rawOrganic > 0 ? totals.eligible / totals.rawOrganic : null,
      };
    })(),
    totals: checkpointTotals,
    executionTotals,
    insertedUrlCandidates: report.insertedUrlCandidates,
    shapeAnomalies: report.shapeAnomalies,
    querySamples: sampleQueries(plan),
    keyUsage: pool.snapshot().keys,
    totalCredit: pool.totalCredit,
    elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    completedPages,
    remainingItems: remaining.total,
    remainingByTier: remaining.byTier,
    unstartedByTier: remaining.unstartedByTier,
    cappedByTier: remaining.cappedByTier,
    stopped,
    failed: report.failed,
    skipped: report.skipped,
  };
  console.log(JSON.stringify(finalReport, null, 2));
  await writeReport(config.reportFile, finalReport);
}

export async function main(): Promise<void> {
  const config = loadBackfillConfig();
  console.log(`[serper_backfill] config=${JSON.stringify(safeConfig(config))}`);
  const plan = buildBackfillPlan(config);
  if (config.dryRun) {
    await runDryRun(config, plan);
    return;
  }
  await runLive(config, plan);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[serper_backfill] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
