import { config } from './config';

export interface CaptchaChallenge {
  websiteUrl: string;
  websiteKey: string;
  dataS?: string;
  userAgent: string;
  cookies: string;
  proxyUrl: string;
}

export interface CaptchaSolution {
  token: string;
  taskId: number;
  cost?: string;
}

interface TwoCaptchaResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: 'processing' | 'ready';
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
  cost?: string;
}

type FetchLike = typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyTaskFields(raw: string): Record<string, string | number> {
  const proxy = new URL(raw);
  const scheme = proxy.protocol.replace(':', '').toLowerCase();
  const proxyType = scheme === 'socks5' || scheme === 'socks4' ? scheme : 'http';
  const fields: Record<string, string | number> = {
    proxyType,
    proxyAddress: proxy.hostname,
    proxyPort: Number(proxy.port),
  };
  if (proxy.username) fields.proxyLogin = decodeURIComponent(proxy.username);
  if (proxy.password) fields.proxyPassword = decodeURIComponent(proxy.password);
  return fields;
}

export class CaptchaSolver {
  constructor(
    private readonly apiKey = config.captcha.apiKey,
    private readonly timeoutMs = config.captcha.timeoutMs,
    private readonly pollMs = config.captcha.pollMs,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<TwoCaptchaResponse> {
    const response = await this.fetchFn(`https://api.2captcha.com/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
    });
    if (!response.ok) throw new Error(`2captcha HTTP ${response.status}`);
    const payload = (await response.json()) as TwoCaptchaResponse;
    if (payload.errorId) {
      throw new Error(
        `2captcha ${payload.errorCode ?? 'error'}: ${payload.errorDescription ?? 'unknown error'}`,
      );
    }
    return payload;
  }

  async solve(challenge: CaptchaChallenge): Promise<CaptchaSolution> {
    if (!this.enabled) throw new Error('2captcha is disabled');
    const task: Record<string, unknown> = {
      type: 'RecaptchaV2Task',
      websiteURL: challenge.websiteUrl,
      websiteKey: challenge.websiteKey,
      recaptchaDataSValue: challenge.dataS || undefined,
      isInvisible: false,
      userAgent: challenge.userAgent,
      cookies: challenge.cookies || undefined,
      ...proxyTaskFields(challenge.proxyUrl),
    };
    const created = await this.post('createTask', { clientKey: this.apiKey, task });
    if (!created.taskId) throw new Error('2captcha did not return taskId');

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      const result = await this.post('getTaskResult', {
        clientKey: this.apiKey,
        taskId: created.taskId,
      });
      if (result.status !== 'ready') continue;
      const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
      if (!token) throw new Error('2captcha returned an empty token');
      return { token, taskId: created.taskId, cost: result.cost };
    }
    throw new Error(`2captcha timeout after ${this.timeoutMs}ms`);
  }
}
