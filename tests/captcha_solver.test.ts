import test from 'node:test';
import assert from 'node:assert/strict';

import { CaptchaSolver } from '../src/captcha_solver';

test('2captcha task uses the same proxy, cookies, user-agent and data-s', async () => {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    requests.push({ path, body });
    if (path.endsWith('/createTask')) {
      return new Response(JSON.stringify({ errorId: 0, taskId: 42 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        errorId: 0,
        status: 'ready',
        solution: { gRecaptchaResponse: 'solved-token' },
        cost: '0.003',
      }),
      { status: 200 },
    );
  };
  const solver = new CaptchaSolver('api-key', 1_000, 1, mockFetch);

  const result = await solver.solve({
    websiteUrl: 'https://www.google.com/sorry/index',
    websiteKey: 'site-key',
    dataS: 'data-s-value',
    userAgent: 'Mozilla/5.0 test',
    cookies: 'CONSENT=YES',
    proxyUrl: 'http://proxy-user:proxy-pass@proxy.example:8080',
  });

  assert.equal(result.token, 'solved-token');
  assert.equal(requests.length, 2);
  const task = requests[0].body.task;
  assert.equal(task.type, 'RecaptchaV2Task');
  assert.equal(task.proxyAddress, 'proxy.example');
  assert.equal(task.proxyPort, 8080);
  assert.equal(task.proxyLogin, 'proxy-user');
  assert.equal(task.proxyPassword, 'proxy-pass');
  assert.equal(task.recaptchaDataSValue, 'data-s-value');
  assert.equal(task.cookies, 'CONSENT=YES');
});

test('solver stays disabled without an API key', async () => {
  const solver = new CaptchaSolver('', 1_000, 1);
  assert.equal(solver.enabled, false);
});
