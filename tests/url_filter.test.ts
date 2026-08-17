import test from 'node:test';
import assert from 'node:assert/strict';

import { isEligiblePostUrl } from '../src/url_filter';
import { isLikelyAdResult } from '../src/platforms';

test('facebook filter rejects noisy surfaces and keeps real posts', () => {
  assert.equal(isEligiblePostUrl('https://www.facebook.com/events/123', 'facebook.com'), false);
  assert.equal(isEligiblePostUrl('https://www.facebook.com/100064773004139/photos/1234567890/', 'facebook.com'), false);
  assert.equal(isEligiblePostUrl('https://www.facebook.com/story.php?fbid=1234567890&id=42', 'facebook.com'), false);
  assert.equal(isEligiblePostUrl('https://www.facebook.com/groups/test/permalink/1234567890/', 'facebook.com'), true);
  assert.equal(isEligiblePostUrl('https://www.facebook.com/watch/?v=1234567890', 'facebook.com'), true);
});

test('x filter keeps status links only', () => {
  assert.equal(isEligiblePostUrl('https://x.com/someone/status/1234567890', 'x.com'), true);
  assert.equal(isEligiblePostUrl('https://x.com/explore', 'x.com'), false);
});

test('ad heuristic flags hotline-style snippets but keeps ordinary discussion text', () => {
  assert.equal(
    isLikelyAdResult('Tour Đà Nẵng giá rẻ', 'Liên hệ hotline 0909123456 để đặt tour ngay'),
    true,
  );
  assert.equal(
    isLikelyAdResult('Xin review lịch trình Đà Nẵng 3N2Đ', 'Cho mình hỏi ăn gì chơi gì ở Mỹ Khê'),
    false,
  );
});
