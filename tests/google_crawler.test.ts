import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import {
  buildDesktopUserAgent,
  buildGoogleSearchUrl,
  captureRecaptchaAudio,
  crawlerFailureCode,
  extractGoogleResults,
  GOOGLE_BROWSER_ARGS,
  GoogleCrawlerError,
  htmlLooksLikeCaptcha,
  normalizeGoogleResultUrl,
  openRecaptchaAudioChallenge,
  runGoogleCrawler,
  shouldReloadRecaptchaAudio,
  shouldAbortBrowserRequest,
  waitForAudioAnswerVerification,
} from '../src/google_crawler';
import { ProxyPool } from '../src/proxy_pool';

test('Google URL carries full dork, paging and relative time filter', () => {
  const url = new URL(
    buildGoogleSearchUrl(
      {
        id: 'q1',
        query: 'site:facebook.com "Đà Nẵng" "du lịch" after:2026-06-24',
        site: 'facebook.com',
        maxPages: 3,
        timeFilter: 'past_week',
      },
      20,
    ),
  );
  assert.equal(url.searchParams.get('start'), '20');
  assert.equal(url.searchParams.get('num'), '10');
  assert.equal(url.searchParams.get('tbs'), 'qdr:w');
  assert.match(url.searchParams.get('q') ?? '', /site:facebook\.com/);
});

test('normalizes Google redirects and rejects Google navigation links', () => {
  assert.equal(
    normalizeGoogleResultUrl(
      'https://www.google.com/url?q=https%3A%2F%2Fwww.facebook.com%2Fgroups%2Fx%2Fposts%2F123&sa=U',
    ),
    'https://www.facebook.com/groups/x/posts/123',
  );
  assert.equal(normalizeGoogleResultUrl('https://www.google.com/preferences'), undefined);
});

test('detects both English and Vietnamese Google captcha pages', () => {
  assert.equal(htmlLooksLikeCaptcha('Our systems have detected unusual traffic'), true);
  assert.equal(htmlLooksLikeCaptcha('Lưu lượng truy cập bất thường'), true);
  assert.equal(htmlLooksLikeCaptcha('<main>ordinary results</main>'), false);
});

test('crawler diagnostics never return browser or proxy error text', () => {
  const sensitiveError = new Error('net::ERR http://user:password@proxy.example:8080/?audio=secret');

  assert.equal(crawlerFailureCode(sensitiveError), 'unexpected');
  assert.equal(crawlerFailureCode(new GoogleCrawlerError('private detail', 'captcha')), 'captcha');
});

test('desktop user-agent keeps Chromium version without HeadlessChrome', () => {
  const ua = buildDesktopUserAgent('143.0.7499.4');
  assert.match(ua, /Chrome\/143\.0\.7499\.4/);
  assert.doesNotMatch(ua, /HeadlessChrome/);
  assert.match(ua, /Windows NT 10\.0/);
});

test('browser transport disables the Google-problematic protocols without removing anti-detection flag', () => {
  assert.deepEqual(GOOGLE_BROWSER_ARGS, [
    '--disable-blink-features=AutomationControlled',
    '--disable-http2',
    '--disable-quic',
  ]);
});

test('route keeps only valid reCAPTCHA audio media while blocking other heavy resources', () => {
  assert.equal(
    shouldAbortBrowserRequest('media', 'https://www.google.com/recaptcha/api2/payload?p=temporary'),
    false,
  );
  assert.equal(
    shouldAbortBrowserRequest('media', 'https://google.com.evil.example/recaptcha/api2/payload'),
    true,
  );
  assert.equal(shouldAbortBrowserRequest('media', 'http://www.google.com/recaptcha/api2/payload'), true);
  assert.equal(shouldAbortBrowserRequest('media', 'https://www.google.com/recaptcha/api2/anchor'), true);
  assert.equal(shouldAbortBrowserRequest('image', 'https://www.google.com/logo.png'), true);
  assert.equal(shouldAbortBrowserRequest('font', 'https://fonts.example/font.woff2'), true);
  assert.equal(shouldAbortBrowserRequest('script', 'https://www.google.com/recaptcha/api.js'), false);
});

test('audio capture reports a safe reason when the control is missing', async () => {
  const page = {
    waitForResponse: async () => {
      throw new Error('must not wait without a control');
    },
  } as unknown as Parameters<typeof captureRecaptchaAudio>[0];
  const frame = {
    locator: () => ({
      first: () => ({
        count: async () => 0,
        isVisible: async () => false,
        isEnabled: async () => false,
      }),
    }),
  } as unknown as Parameters<typeof captureRecaptchaAudio>[1];

  assert.deepEqual(await captureRecaptchaAudio(page, frame, false), {
    status: 'failure',
    reasonCode: 'audio_control_unavailable',
  });
});

test('audio capture arms the response listener before clicking and keeps bytes in the page path', async () => {
  let listenerArmed = false;
  let clicked = false;
  const body = Buffer.from('audio-from-page');
  const response = {
    url: () => 'https://www.google.com/recaptcha/api2/payload?p=opaque',
    ok: () => true,
    headers: () => ({ 'content-type': 'audio/mpeg', 'content-length': String(body.length) }),
    body: async () => body,
  };
  const page = {
    waitForResponse: async () => {
      listenerArmed = true;
      return response;
    },
  } as unknown as Parameters<typeof captureRecaptchaAudio>[0];
  const frame = {
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
          assert.equal(listenerArmed, true);
          clicked = true;
        },
      }),
    }),
  } as unknown as Parameters<typeof captureRecaptchaAudio>[1];

  const captured = await captureRecaptchaAudio(page, frame, false);
  assert.equal(clicked, true);
  assert.equal(captured.status, 'success');
  if (captured.status === 'success') {
    assert.deepEqual(captured.audioBytes, body);
    assert.equal(captured.contentType, 'audio/mpeg');
  }
});

test('audio capture does not expose an error message when response capture times out', async () => {
  const page = {
    waitForResponse: async () => {
      throw new Error('https://user:password@proxy.example/secret');
    },
  } as unknown as Parameters<typeof captureRecaptchaAudio>[0];
  const frame = {
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {},
      }),
    }),
  } as unknown as Parameters<typeof captureRecaptchaAudio>[1];

  const result = await captureRecaptchaAudio(page, frame, false);
  assert.deepEqual(result, { status: 'failure', reasonCode: 'audio_response_timeout' });
  assert.doesNotMatch(JSON.stringify(result), /user:password|secret/);
});

test('audio capture retries the exact enabled control with force only after a normal click fails', async () => {
  let clicks = 0;
  let scrolls = 0;
  const body = Buffer.from('audio-from-page');
  const response = {
    url: () => 'https://www.google.com/recaptcha/api2/payload?p=opaque',
    ok: () => true,
    headers: () => ({ 'content-type': 'audio/mpeg', 'content-length': String(body.length) }),
    body: async () => body,
  };
  const page = {
    waitForResponse: async () => response,
  } as unknown as Parameters<typeof captureRecaptchaAudio>[0];
  const frame = {
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async (options?: { force?: boolean }) => {
          clicks += 1;
          if (!options?.force) throw new Error('covered control');
        },
        scrollIntoViewIfNeeded: async () => {
          scrolls += 1;
        },
      }),
    }),
  } as unknown as Parameters<typeof captureRecaptchaAudio>[1];

  const captured = await captureRecaptchaAudio(page, frame, false);
  assert.equal(captured.status, 'success');
  assert.equal(clicks, 2);
  assert.equal(scrolls, 1);
});

test('audio retry uses reload only after an audio request could have been sent', () => {
  assert.equal(
    shouldReloadRecaptchaAudio({ status: 'failure', reasonCode: 'audio_control_disabled' }),
    false,
  );
  assert.equal(
    shouldReloadRecaptchaAudio({ status: 'failure', reasonCode: 'audio_control_click_failed' }),
    false,
  );
  assert.equal(
    shouldReloadRecaptchaAudio({ status: 'failure', reasonCode: 'audio_response_timeout' }),
    true,
  );
  assert.equal(
    shouldReloadRecaptchaAudio({ status: 'success', audioUrl: 'https://example.test', audioBytes: Buffer.alloc(0), contentType: null }),
    true,
  );
});

test('audio answer verification distinguishes HTTP rejection from a verified checkbox', async () => {
  const rejectedPage = {
    waitForResponse: async () => ({
      url: () => 'https://www.google.com/recaptcha/api2/userverify?k=opaque',
      ok: () => false,
    }),
  } as unknown as Parameters<typeof waitForAudioAnswerVerification>[0];
  assert.equal(await waitForAudioAnswerVerification(rejectedPage), 'answer_verification_http_error');

  const anchor = {
    url: () => 'https://www.google.com/recaptcha/api2/anchor?k=opaque',
    locator: () => ({
      count: async () => 1,
      getAttribute: async () => 'true',
      first: () => ({
        count: async () => 1,
        getAttribute: async () => 'true',
      }),
    }),
  };
  const verifiedPage = {
    waitForResponse: async () => ({
      url: () => 'https://www.google.com/recaptcha/api2/userverify?k=opaque',
      ok: () => true,
    }),
    frames: () => [anchor],
  } as unknown as Parameters<typeof waitForAudioAnswerVerification>[0];
  assert.equal(await waitForAudioAnswerVerification(verifiedPage), 'verified');
});

test('opens the reCAPTCHA checkbox when an audio challenge frame is not present yet', async () => {
  let checkboxClicks = 0;
  const anchor = {
    url: () => 'https://www.google.com/recaptcha/api2/anchor?k=site-key',
    locator: () => ({
      first: () => ({
        count: async () => 1,
        getAttribute: async () => 'false',
        click: async () => {
          checkboxClicks += 1;
        },
      }),
      count: async () => 1,
    }),
  };
  const challenge = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=site-key',
    locator: () => ({ count: async () => (checkboxClicks === 1 ? 1 : 0) }),
  };
  const page = { frames: () => [anchor, challenge] } as unknown as Parameters<
    typeof openRecaptchaAudioChallenge
  >[0];

  const actual = await openRecaptchaAudioChallenge(page);

  assert.equal(actual, challenge);
  assert.equal(checkboxClicks, 1);
});

test('does not toggle an already-open reCAPTCHA challenge', async () => {
  let checkboxClicks = 0;
  const anchor = {
    url: () => 'https://www.google.com/recaptcha/api2/anchor?k=site-key',
    locator: () => ({
      first: () => ({
        count: async () => 1,
        getAttribute: async () => 'false',
        click: async () => {
          checkboxClicks += 1;
        },
      }),
      count: async () => 1,
    }),
  };
  const challenge = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=site-key',
    locator: () => ({ count: async () => 1 }),
  };
  const page = { frames: () => [anchor, challenge] } as unknown as Parameters<
    typeof openRecaptchaAudioChallenge
  >[0];

  const actual = await openRecaptchaAudioChallenge(page);

  assert.equal(actual, challenge);
  assert.equal(checkboxClicks, 0);
});

test('an already-aborted probe signal skips crawler work before opening a browser', async () => {
  const abortController = new AbortController();
  abortController.abort();
  let resultCallbacks = 0;

  const stats = await runGoogleCrawler({
    queries: [
      {
        id: 'cancelled-probe',
        query: 'site:facebook.com test',
        site: 'facebook.com',
        maxPages: 1,
      },
    ],
    proxyPool: new ProxyPool([]),
    abortSignal: abortController.signal,
    onResults: async () => {
      resultCallbacks += 1;
      return 0;
    },
  });

  assert.equal(resultCallbacks, 0);
  assert.deepEqual(stats, {
    totalQueries: 1,
    totalFound: 0,
    totalInserted: 0,
    totalDuplicates: 0,
    failedQueries: [],
    blockedQueries: [],
  });
});

test('extracts canonical and redirected organic results from a SERP fixture', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="search">
        <div class="tF2Cxc">
          <a href="https://www.facebook.com/groups/dulich/posts/123456789012345"><h3>Review Đà Nẵng</h3></a>
          <div class="VwiC3b">Chia sẻ chuyến du lịch Mỹ Khê.</div>
        </div>
        <div class="tF2Cxc">
          <a href="/url?q=https%3A%2F%2Fwww.instagram.com%2Fp%2FABC123%2F"><h3>Hội An</h3></a>
          <div data-sncf="1"><div>Kinh nghiệm du lịch Hội An.</div></div>
        </div>
        <div class="tF2Cxc" data-text-ad>
          <a href="https://ad.example"><h3>Quảng cáo</h3></a>
        </div>
      </div>
    `);

    const results = await extractGoogleResults(page);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'Review Đà Nẵng');
    assert.equal(results[0].source, 'google');
    assert.equal(results[1].url, 'https://www.instagram.com/p/ABC123/');
    assert.match(results[1].snippet, /Kinh nghiệm/);
  } finally {
    await browser.close();
  }
});
