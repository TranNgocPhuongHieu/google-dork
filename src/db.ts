import 'dotenv/config'; // PHẢI nạp trước khi tạo Pool — đảm bảo DATABASE_URL có mặt
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Kafka, Consumer, Producer, EachMessagePayload } from 'kafkajs';
import { createLogger, kafkaLogCreator } from './logger';
import { config } from './config';
import { DorkTriggerPayload, parseDorkTriggerPayload } from './payload';
export { extractPostId } from './platforms';

const logger = createLogger('db');

// ─── Connection Pool ───────────────────────────────────────

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({ connectionString: config.databaseUrl });

// node-postgres BẮT BUỘC có handler này: khi server đóng một idle connection,
// Pool phát sự kiện 'error'; không ai nghe → Node ném unhandled → crash daemon.
pool.on('error', (err) => {
  logger.error(`Idle client error: ${err.message}`);
});

export async function closeDb(): Promise<void> {
  await pool.end();
}

// ─── Kafka Consumer ────────────────────────────
// Chỉ khởi động nếu KAFKA_ENABLED=true

let kafkaConsumer: Consumer | null = null;

export async function closeKafka(): Promise<void> {
  if (kafkaConsumer) await kafkaConsumer.disconnect();
}

/**
 * Khởi động Kafka consumer lắng nghe topic `social.dork.trigger`.
 * Mỗi message là 1 job crawl với params: sites, date_from, date_to, keyword_ids, v.v.
 * onMessage được gọi với parsed payload khi có message mới.
 */
export async function initKafkaConsumer(
  onMessage: (payload: DorkTriggerPayload) => Promise<void>,
): Promise<void> {
  if (!config.kafka.enabled) {
    logger.info('KAFKA_ENABLED != true — consumer không khởi động, chạy theo env vars một lần.');
    return;
  }
  const brokers = config.kafka.bootstrapServers;
  const kafka = new Kafka({ clientId: 'google-dork-consumer', brokers, logCreator: kafkaLogCreator });
  kafkaConsumer = kafka.consumer({ groupId: config.kafka.consumerGroupId });
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topic: config.kafka.triggerTopic, fromBeginning: false });

  await kafkaConsumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
      const commitCurrentOffset = async () => kafkaConsumer!.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);

      if (!message.value) {
        logger.warning(`Skipping empty Kafka message topic=${topic} partition=${partition} offset=${message.offset}`);
        await commitCurrentOffset();
        return;
      }

      let payload: DorkTriggerPayload;
      try {
        const rawPayload = JSON.parse(message.value.toString());
        payload = parseDorkTriggerPayload(rawPayload);
      } catch (e) {
        await commitCurrentOffset();
        logger.error(`Message processing failed: ${e}`);
        return;
      }

      try {
        // Keep at-most-once semantics for valid jobs: once validated, we commit
        // before the potentially long-running crawl starts.
        await commitCurrentOffset();
        await onMessage(payload);
      } catch (e) {
        logger.error(`Message processing failed: ${e}`);
      }
    },
  });

  logger.debug(`Consumer subscribed topic=${config.kafka.triggerTopic} brokers=${brokers.join(',')}`);
}

// ─── Kafka Producer (done signal) ──────────────────────────
// Publish tín hiệu "đã cào xong" lên topic CHUNG `social.done`. Đây là tín hiệu
// phụ cho monitoring/điều phối — best-effort, KHÔNG bao giờ làm chết daemon cào.

const DONE_TOPIC = config.kafka.doneTopic;

let kafkaProducer: Producer | null = null;

/**
 * Khởi tạo producer + ensure topic `social.done` (best-effort).
 * Chỉ chạy ở chế độ daemon (KAFKA_ENABLED=true). Lỗi khởi tạo chỉ log.
 */
export async function initKafkaProducer(): Promise<void> {
  if (!config.kafka.enabled) return;
  try {
    const brokers = config.kafka.bootstrapServers;
    const kafka = new Kafka({ clientId: 'google-dork-producer', brokers, logCreator: kafkaLogCreator });

    try {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: DONE_TOPIC, numPartitions: 1, replicationFactor: 1 }],
      });
      await admin.disconnect();
    } catch { /* topic đã tồn tại hoặc admin lỗi — bỏ qua */ }

    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();
    logger.debug(`Done producer connected topic=${DONE_TOPIC}`);
  } catch (e) {
    kafkaProducer = null;
    logger.warning(`Done producer init failed: ${e}`);
  }
}

export async function closeKafkaProducer(): Promise<void> {
  if (kafkaProducer) {
    try { await kafkaProducer.disconnect(); } catch { /* ignore */ }
    kafkaProducer = null;
  }
}

/**
 * Publish 1 message done lên `social.done`.
 * key = jobId, value = {source, status:'done', ...metadata}. Best-effort: lỗi chỉ WARNING.
 */
export async function publishDone(
  jobId: string,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!kafkaProducer) return;
  try {
    await kafkaProducer.send({
      topic: DONE_TOPIC,
      messages: [{ key: jobId ?? null, value: JSON.stringify({ source, status: 'done', ...metadata }) }],
    });
    logger.info(`Published done topic=${DONE_TOPIC} source=${source} key=${jobId}`);
  } catch (e) {
    logger.warning(`Publish done failed (source=${source}, key=${jobId}): ${e}`);
  }
}

// ─── Platform cache ────────────────────────────────────────

const platformCache = new Map<string, number>();

export async function loadPlatformCache(): Promise<void> {
  const { rows } = await pool.query<{ platform_id: number; domain: string }>(
    'SELECT platform_id, domain FROM dim_platform',
  );
  for (const row of rows) platformCache.set(row.domain, row.platform_id);
  logger.debug(`Platform cache loaded entries=${platformCache.size}`);
}

export function resolvePlatformId(domain: string): number {
  const id = platformCache.get(domain);
  if (id === undefined) throw new Error(`Platform not found: ${domain}`);
  return id;
}

// ─── Keyword ───────────────────────────────────────────────

export async function getKeywordsByIds(ids: number[]) {
  if (ids.length === 0) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT keyword_id, keyword, province FROM dim_keyword WHERE keyword_id IN (${ph}) ORDER BY keyword_id`,
    ids,
  );
  return rows;
}

export async function getAllKeywords() {
  const { rows } = await pool.query(
    'SELECT keyword_id, keyword, province FROM dim_keyword WHERE is_enabled = TRUE ORDER BY keyword_id',
  );
  return rows;
}

// ─── Bulk Insert ───────────────────────────

interface PostInsert { postId: string; url: string }

/**
 * Insert posts vào DB (idempotent).
 */
export async function insertPosts(
  posts: PostInsert[],
  platformId: number,
  keywordId: number,
  runId?: string,
): Promise<number> {
  if (posts.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < posts.length; i++) {
    const o = i * 6;
    placeholders.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6})`);
    values.push(posts[i].postId, posts[i].url, platformId, keywordId, 'pending', runId ?? null);
  }

  const result = await pool.query(
    `INSERT INTO fact_post (post_id, url, platform_id, keyword_id, status, source_run_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (post_id) DO NOTHING
     RETURNING post_id, url, platform_id, keyword_id`,
    values,
  );

  return result.rows.length;
}

// ─── Crawl Run tracking ────────────────────────────────────

export interface CrawlRunTotals { totalUrlsDiscovered: number; totalUrlsScraped?: number }

export async function createCrawlRun(
  platformId: number,
  runType: 'daily' | 'backfill' | 'reconciliation',
  searchWindowStart: Date,
  searchWindowEnd: Date,
): Promise<string> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO fact_crawl_run (run_id, platform_id, run_type, search_window_start, search_window_end, status)
     VALUES ($1, $2, $3, $4, $5, 'running')`,
    [runId, platformId, runType, searchWindowStart, searchWindowEnd],
  );
  // run_id đã được log ở main.ts khi cần
  return runId;
}

export async function completeCrawlRun(
  runId: string,
  totals: CrawlRunTotals,
  success: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE fact_crawl_run
     SET status=$2, total_urls_discovered=$3, total_urls_scraped=$4, completed_at=NOW()
     WHERE run_id=$1`,
    [runId, success ? 'completed' : 'failed', totals.totalUrlsDiscovered, totals.totalUrlsScraped ?? 0],
  );
}
