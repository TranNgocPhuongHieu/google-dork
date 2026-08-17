import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/social_scraper';

const dbModulePromise = import('../src/db');

after(async () => {
  const { closeDb } = await dbModulePromise;
  await closeDb();
});

test('extractPostId supports current social URL shapes', async () => {
  const { extractPostId } = await dbModulePromise;

  assert.equal(
    extractPostId('https://www.facebook.com/story.php?story_fbid=1234567890&id=42', 'facebook.com'),
    '1234567890',
  );
  assert.equal(
    extractPostId('https://www.instagram.com/p/C9abc123xyz/', 'instagram.com'),
    'C9abc123xyz',
  );
  assert.equal(
    extractPostId('https://x.com/someone/status/1234567890123456789', 'x.com'),
    '1234567890123456789',
  );
});
