import 'dotenv/config';
import { buildQueries, BuiltQuery, DateQueryMode, GoogleTimeFilter } from './src/query_builder';
import { SearchResult } from './src/types';
import { closeGoogleCrawler, GoogleQuerySpec, runGoogleCrawler } from './src/google_crawler';
import { isEligiblePostUrl } from './src/url_filter';
import { validateDiscoveredUrl } from './src/validator';
import { config, describeConfig } from './src/config';
import { normalizeSite, buildSiteSearchTexts, isLikelyAdResult } from './src/platforms';
import { getProvince } from './src/entity_registry';
import { getProfile, SearchProfile } from './src/profiles';
import { chunkPlaces, selectDuePlaces, windowFor } from './src/place_scheduler';
import { resolveMaxPages } from './src/page_depth';
import { CadenceGroup, PlaceEntry } from './src/profiles/types';
import {
  loadPlatformCache,
  resolvePlatformId,
  extractPostId,
  insertPosts,
  closeDb,
  closeKafka,
  initKafkaConsumer,
  initKafkaProducer,
  closeKafkaProducer,
  publishDone,
  getKeywordsByIds,
  getAllKeywords,
  createCrawlRun,
  completeCrawlRun,
} from './src/db';
import { createLogger, logJobReceived } from './src/logger';
import { DorkTriggerPayload, parseDorkTriggerPayload } from './src/payload';

const logger = createLogger('main');
const kafkaLogger = createLogger('kafka_consumer');

interface KeywordEntry {
  keyword_id: number;
  province: string; // ASCII slug; matches entity_registry + dim_keyword.province
}

interface JobRunSummary {
  totalUrlsScraped: number;
  urlsScrapedBySite: Record<string, number>;
}

interface SearchWindow {
  dateFrom: string;
  dateTo: string;
  cadence?: CadenceGroup;
  places?: PlaceEntry[];
}

interface PlannedQuery {
  query: BuiltQuery;
  maxPages: number;
}

class JobFailedError extends Error {
  summary: JobRunSummary;

  constructor(message: string, summary: JobRunSummary) {
    super(message);
    this.name = 'JobFailedError';
    this.summary = summary;
  }
}

/**
 * Load keywords từ DATABASE.
 */
async function loadKeywords(keywordIds?: number[]): Promise<KeywordEntry[]> {
  let dbKeywords: { keyword_id: number; keyword: string; province: string }[];

  if (!keywordIds || keywordIds.length === 0) {
    dbKeywords = await getAllKeywords();
  } else {
    dbKeywords = await getKeywordsByIds(keywordIds);
  }

  if (dbKeywords.length === 0) {
    throw new Error('Không tìm thấy keyword nào trong DB để cào.');
  }

  // dim_keyword now carries only the province (name in `keyword`, slug in
  // `province`). The per-site search strategy lives in entity_registry, keyed by
  // slug — so the literal `keyword` text is no longer used to build dorks.
  const entries: KeywordEntry[] = dbKeywords.map((row) => ({
    keyword_id: row.keyword_id,
    province: row.province,
  }));

  const missing = entries.filter((e) => !getProvince(e.province));
  if (missing.length > 0) {
    logger.warning(
      `Provinces missing from entity_registry (will produce 0 queries): ${missing
        .map((m) => m.province)
        .join(', ')}`,
    );
  }

  logger.debug(`Loaded keywords count=${entries.length}`);
  return entries;
}

async function runOneKeyword(
  entry: KeywordEntry,
  sites: string[],
  profile: SearchProfile,
  dateFrom: string,
  dateTo: string,
  splitDays: number,
  timeFilter: DorkTriggerPayload['time_filter'] | undefined,
  jobType: DorkTriggerPayload['job_type'],
  requestedMaxPages: number,
  runIdBySite?: Map<string, string>,
  insertedBySite?: Map<string, number>,
  today: Date = new Date(),
) {
  const { keyword_id, province } = entry;
  const keywordId = keyword_id;
  logger.debug(`[${province}] keyword_id=${keywordId}`);

  const profileSpec = getProfile(profile);

  const queriesData: PlannedQuery[] = [];
  const effectiveTimeFilter = (timeFilter ?? 'custom') as GoogleTimeFilter;
  const isRelativeFilter = effectiveTimeFilter !== 'custom';
  const dateMode: DateQueryMode = jobType === 'daily' ? 'rolling' : 'bounded';
  const effectiveSplitDays = isRelativeFilter
    ? 0
    : jobType === 'backfill' || jobType === 'reconciliation'
      ? 1
      : jobType === 'daily'
        ? 0
        : splitDays;
  const provinceEntry = getProvince(province);
  const tier = provinceEntry?.tier ?? 'C';
  const legacyTierMaxPages = {
    A: config.search.tierAMaxPages,
    B: config.search.tierBMaxPages,
    C: config.search.tierCMaxPages,
  };

  const searchWindows: SearchWindow[] = [];
  if (profileSpec.useLegacyRegistry) {
    // Keep the legacy registry path on the original payload date window.
    searchWindows.push({ dateFrom, dateTo });
  } else {
    if (profileSpec.placesPerQuery < 1) {
      throw new Error(`Profile ${profile} placesPerQuery must be at least 1`);
    }

    const provincePlaces = profileSpec.places.filter((place) => place.provinceSlug === province);
    const chunks = chunkPlaces(provincePlaces, profileSpec.placesPerQuery);
    const dueChunks = selectDuePlaces(chunks, profileSpec.cadence, today);

    for (const chunk of dueChunks) {
      const window = windowFor(chunk, profileSpec.cadence, today);
      searchWindows.push({ ...window, cadence: chunk.cadence, places: chunk.places });
    }

    if (searchWindows.length === 0) {
      logger.debug(`[${province}] profile=${profile} has no due places`);
    }
  }

  // Expand the province into one accuracy-first dork per site/date window.
  for (const searchWindow of searchWindows) {
    const maxPages = resolveMaxPages(profileSpec, tier, searchWindow.cadence, {
      requestedMaxPages,
      searchMaxPages: config.search.maxPages,
      legacyTierMaxPages,
    });
    for (const site of sites) {
      const searchTexts = buildSiteSearchTexts(site, province, profile, searchWindow.places);
      for (const st of searchTexts) {
        const siteQueries = buildQueries(
          [site],
          st,
          searchWindow.dateFrom,
          searchWindow.dateTo,
          effectiveSplitDays,
          effectiveTimeFilter,
          dateMode,
        );
        queriesData.push(...siteQueries.map((query) => ({ query, maxPages })));
      }
    }
  }

  const queryToSite = new Map<string, string>();
  for (const { query } of queriesData) queryToSite.set(query.query, query.site);

  // Keep URL validation, post-id extraction and DB insertion unchanged.
  const onResults = async (results: SearchResult[], query: string): Promise<number> => {
    const site = queryToSite.get(query);
    if (!site) {
      logger.warning(`[${province}] Unknown query mapping: ${query}`);
      return 0;
    }
    const platformId = resolvePlatformId(site);

    const validPosts: { postId: string; url: string }[] = [];
    let skippedNoId = 0;
    let skippedInvalidPattern = 0;
    let skippedInaccessible = 0;
    let skippedCommercial = 0;

    for (const item of results) {
      if (isLikelyAdResult(item.title, item.snippet)) {
        skippedCommercial++;
        continue;
      }

      const postId = extractPostId(item.url, site);
      if (!postId) {
        skippedNoId++;
        continue;
      }

      const isEligible = isEligiblePostUrl(item.url, site);
      if (!isEligible) {
        skippedInvalidPattern++;
        continue;
      }

      const urlStatus = await validateDiscoveredUrl(item.url, site);
      if (urlStatus !== 'accessible') {
        logger.debug(`[${province}][${site}] Rejected URL (Status: ${urlStatus}): ${item.url}`);
        skippedInaccessible++;
        continue;
      }

      validPosts.push({ postId, url: item.url });
    }

    const totalSkipped = skippedNoId + skippedInvalidPattern + skippedInaccessible + skippedCommercial;
    if (totalSkipped > 0) {
      logger.debug(
        `[${province}][${site}] Skipped ${totalSkipped} (Ad:${skippedCommercial} NoID:${skippedNoId} BadPattern:${skippedInvalidPattern} Inaccessible:${skippedInaccessible})`,
      );
    }

    if (validPosts.length === 0) return 0;
    const runId = runIdBySite?.get(site);
    const inserted = await insertPosts(validPosts, platformId, keywordId, runId);
    if (insertedBySite) {
      insertedBySite.set(site, (insertedBySite.get(site) ?? 0) + inserted);
    }
    return inserted;
  };

  const onProgress = (p: { page: number; inserted: number; hasNextPage: boolean }) => {
    if (config.log.level === 'DEBUG') {
      logger.debug(`[${province}] progress page=${p.page} inserted=${p.inserted} hasNext=${p.hasNextPage}`);
    }
  };

  const specs: GoogleQuerySpec[] = queriesData.map(({ query, maxPages }) => ({
    id: query.query,
    query: query.query,
    site: query.site,
    maxPages,
    timeFilter: effectiveTimeFilter,
  }));

  if (specs.length === 0) {
    return {
      totalQueries: 0,
      totalFound: 0,
      totalInserted: 0,
      totalDuplicates: 0,
      failedQueries: [],
      blockedQueries: [],
      failedSites: [],
      blockedSites: [],
    };
  }

  const stats = await runGoogleCrawler({ queries: specs, onResults, onProgress, logPrefix: province });
  const failedSites = Array.from(
    new Set(stats.failedQueries.map((query) => queryToSite.get(query)).filter((site): site is string => Boolean(site))),
  );
  const blockedSites = Array.from(
    new Set(stats.blockedQueries.map((query) => queryToSite.get(query)).filter((site): site is string => Boolean(site))),
  );

  return { ...stats, failedSites, blockedSites };
}

/**
 * Chạy 1 job crawl hoàn chỉnh từ DorkTriggerPayload.
 * Dùng cho cả chế độ Kafka daemon và chế độ one-shot (env vars).
 */
async function runJob(payload: DorkTriggerPayload): Promise<JobRunSummary> {
  const startMs = Date.now();
  const {
    job_id,
    job_type,
    search_sites: rawSites,
    date_from: dateFrom,
    date_to: dateTo,
    keyword_ids,
    search_profile: searchProfile,
    time_filter: timeFilter,
    split_days: splitDays = config.search.splitDays,
    max_pages: maxPages = config.search.maxPages,
  } = payload;

  const profileSpec = getProfile(searchProfile);
  const scheduleToday = new Date();

  // Job-scoped logger with structured fields (works with LOG_FORMAT=json)
  const jobLogger = createLogger('job', { job_id, job_type, search_profile: searchProfile });

  const requestedSites = Array.from(new Set(rawSites.map((s) => normalizeSite(s)).filter(Boolean)));
  const profileSites = new Set(profileSpec.sites.map((site) => normalizeSite(site)));
  const sites = profileSpec.useLegacyRegistry
    ? requestedSites
    : requestedSites.filter((site) => profileSites.has(site));
  const unsupportedSites = profileSpec.useLegacyRegistry
    ? []
    : requestedSites.filter((site) => !profileSites.has(site));
  if (unsupportedSites.length > 0) {
    jobLogger.warning('sites_not_supported_by_profile', {
      requestedSites: unsupportedSites,
      profileSites: Array.from(profileSites),
    });
  }
  if (sites.length === 0) {
    logger.error(`[Job ${job_id}] no valid search_sites for profile=${searchProfile}`);
    throw new JobFailedError('no valid search_sites', {
      totalUrlsScraped: 0,
      urlsScrapedBySite: {},
    });
  }

  jobLogger.info('START', { sites: sites.join(','), dateFrom, dateTo });
  if (timeFilter && timeFilter !== 'custom') {
    jobLogger.info('time_filter', { timeFilter });
  }

  const keywords = await loadKeywords(keyword_ids);
  const numWorkers = Math.min(config.search.workers, keywords.length);

  const loadedProvinces = new Set(keywords.map((keyword) => keyword.province));
  const missingProfileProvinces = profileSpec.useLegacyRegistry
    ? []
    : Array.from(new Set(profileSpec.places.map((place) => place.provinceSlug)))
        .filter((provinceSlug) => !loadedProvinces.has(provinceSlug));
  if (missingProfileProvinces.length > 0) {
    jobLogger.warning('profile_provinces_missing_from_dim_keyword', {
      provinceSlugs: missingProfileProvinces,
    });
  }

  const dueProfileChunks = profileSpec.useLegacyRegistry
    ? []
    : selectDuePlaces(
        chunkPlaces(profileSpec.places, profileSpec.placesPerQuery),
        profileSpec.cadence,
        scheduleToday,
      );
  const placeCoverage = {
    duePlaces: dueProfileChunks.reduce((sum, chunk) => sum + chunk.places.length, 0),
    totalPlaces: profileSpec.places.length,
  };

  jobLogger.info('job_params', {
    keywords: keywords.length,
    workers: numWorkers,
    search_profile: searchProfile,
    due_places: placeCoverage.duePlaces,
    total_places: placeCoverage.totalPlaces,
  });

  // Tạo crawl_run per site
  const runType = job_type === 'manual' ? 'backfill' : job_type;
  const searchWindowStart = new Date(`${dateFrom}T00:00:00+07:00`);
  const searchWindowEnd   = new Date(`${dateTo}T23:59:59+07:00`);
  const runIdBySite = new Map<string, string>();
  for (const site of sites) {
    try {
      const platformId = resolvePlatformId(site);
      const runId = await createCrawlRun(platformId, runType, searchWindowStart, searchWindowEnd);
      runIdBySite.set(site, runId);
      logger.debug(`[Job ${job_id}] crawl_run created site=${site} run_id=${runId}`);
    } catch (e) {
      logger.warning(`[Job ${job_id}] crawl_run create failed site=${site}: ${e}`);
    }
  }

  let totalFound = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalQueries = 0;
  let totalFailedOrBlocked = 0;
  const insertedBySite = new Map<string, number>(sites.map((site) => [site, 0]));
  const siteFailures = new Map<string, number>();
  const siteBlocks = new Map<string, number>();
  let jobFailed = false;

  // Heartbeat: emit progress every N seconds so monitoring can detect stuck jobs.
  const hbEveryMs = config.search.heartbeatSeconds * 1000;
  let lastHbMs = 0;
  const emitHeartbeat = (extra?: Record<string, unknown>) => {
    const now = Date.now();
    if (now - lastHbMs < hbEveryMs) return;
    lastHbMs = now;
    const durationSec = ((now - startMs) / 1000).toFixed(0);
    jobLogger.info('HEARTBEAT', {
      durationSec,
      totalFound,
      totalInserted,
      totalDuplicates,
      ...extra,
    });
  };

  for (let batchStart = 0; batchStart < keywords.length; batchStart += numWorkers) {
    const batch = keywords.slice(batchStart, batchStart + numWorkers);
    logger.debug(`[Job ${job_id}] batch [${batchStart + 1}-${batchStart + batch.length}/${keywords.length}]`);

    emitHeartbeat({ progress: `${batchStart + 1}-${batchStart + batch.length}/${keywords.length}` });

    const batchResults = await Promise.all(
      batch.map(async (kw) => {
        try {
          const stats = await runOneKeyword(
            kw, sites, searchProfile, dateFrom, dateTo,
            splitDays,
            timeFilter,
            job_type,
            maxPages,
            runIdBySite, insertedBySite,
            scheduleToday,
          );
          return { kw, stats };
        } catch (e) {
          logger.error(`[Job ${job_id}][${kw.province}] FAILED: ${e}`);
          jobFailed = true;
          for (const site of sites) {
            siteFailures.set(site, (siteFailures.get(site) ?? 0) + 1);
          }
          return { kw, stats: null };
        }
      }),
    );

    for (const { kw, stats } of batchResults) {
      if (!stats) continue;
      totalFound += stats.totalFound;
      totalInserted += stats.totalInserted;
      totalDuplicates += stats.totalDuplicates;
      for (const site of stats.failedSites) {
        siteFailures.set(site, (siteFailures.get(site) ?? 0) + 1);
      }
      for (const site of stats.blockedSites) {
        siteBlocks.set(site, (siteBlocks.get(site) ?? 0) + 1);
      }
      totalQueries += stats.totalQueries;
      totalFailedOrBlocked += stats.failedQueries.length + stats.blockedQueries.length;
      // Chỉ log nếu có kết quả hoặc có lỗi
      if (stats.totalFound > 0 || stats.failedQueries.length > 0) {
        logger.info(
          `[Job ${job_id}][${kw.province}] found=${stats.totalFound} new=${stats.totalInserted} dup=${stats.totalDuplicates}` +
          (stats.failedQueries.length > 0 ? ` failed=${stats.failedQueries.length}` : '') +
          (stats.blockedQueries.length > 0 ? ` blocked=${stats.blockedQueries.length}` : ''),
        );
      }

      // Progress heartbeat after each keyword finishes
      emitHeartbeat({ province: kw.province });
    }
  }

  // Rate-based failure: a few blocked/failed queries are normal at scale (Google
  // rate-limits the fixed proxy pool). Only flag the whole job as failed when the
  // failure RATE is high enough to indicate systemic blocking — otherwise a single
  // cooled proxy would mark every large daily job as "failed".
  const failRate = totalQueries > 0 ? totalFailedOrBlocked / totalQueries : 0;
  if (failRate > 0.15) {
    jobFailed = true;
    jobLogger.warning('high_fail_rate', {
      failRate: failRate.toFixed(2),
      totalQueries,
      totalFailedOrBlocked,
    });
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const urlsScrapedBySite = Object.fromEntries(
    sites.map((site) => [site, insertedBySite.get(site) ?? 0]),
  );
  jobLogger.info('DONE', {
    durationSec,
    totalFound,
    totalInserted,
    totalDuplicates,
    urlsScrapedBySite,
    failedSites: siteFailures.size,
    blockedSites: siteBlocks.size,
    jobFailed,
    search_profile: searchProfile,
    due_places: placeCoverage.duePlaces,
    total_places: placeCoverage.totalPlaces,
  });

  // Hoàn thành crawl_run
  for (const [site, runId] of runIdBySite) {
    try {
      const siteInserted = insertedBySite.get(site) ?? 0;
      const siteFailed = (siteFailures.get(site) ?? 0) > 0 || (siteBlocks.get(site) ?? 0) > 0;
      await completeCrawlRun(runId, { totalUrlsDiscovered: siteInserted }, !siteFailed);
    } catch (e) {
      logger.warning(`[Job ${job_id}] crawl_run complete failed site=${site}: ${e}`);
    }
  }

  const summary: JobRunSummary = {
    totalUrlsScraped: totalInserted,
    urlsScrapedBySite,
  };

  if (jobFailed) {
    throw new JobFailedError(
      `job completed with failures or blocks (failed_sites=${siteFailures.size}, blocked_sites=${siteBlocks.size})`,
      summary,
    );
  }

  return summary;
}

// ─── MAIN: Daemon mode (Kafka) hoặc one-shot mode (env vars) ─────────────────

/**
 * Chạy fn với retry + backoff tuyến tính. Dùng cho các bước khởi động phụ thuộc
 * hạ tầng (DB) để daemon không chết ngay khi service chưa sẵn sàng. Hết số lần
 * thử thì ném lỗi để restart:always dựng lại container (tránh che giấu lỗi cấu hình).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 20,
  delayMs = 3000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      logger.warning(`${label} thất bại (lần ${attempt}/${retries}): ${e} — thử lại sau ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  logger.info('Startup config', describeConfig());

  await withRetry(() => loadPlatformCache(), 'loadPlatformCache (DB readiness)');

  const kafkaEnabled = config.kafka.enabled;

  if (kafkaEnabled) {
    const brokers = config.kafka.bootstrapServers.join(',');
    kafkaLogger.info(`Starting consumer topic=${config.kafka.triggerTopic} servers=${brokers} group_id=${config.kafka.consumerGroupId}`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      kafkaLogger.info('Shutdown signal received — cleaning up...');
      await closeKafka();
      await closeKafkaProducer();
      await closeGoogleCrawler();
      await closeDb();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Producer cho tín hiệu done lên topic chung social.done (best-effort).
    await initKafkaProducer();

    await initKafkaConsumer(async (payload: DorkTriggerPayload) => {
      try {
        logJobReceived('kafka_consumer', payload);
        const summary = await runJob(payload);
        // Chỉ báo done khi job chạy xong không lỗi.
        await publishDone(payload.job_id, 'google-dork', {
          result: 'completed',
          search_sites: payload.search_sites,
          total_urls_scraped: summary.totalUrlsScraped,
          urls_scraped_by_site: summary.urlsScrapedBySite,
        });
      } catch (e) {
        if (e instanceof JobFailedError) {
          await publishDone(payload.job_id, 'google-dork', {
            result: 'failed',
            search_sites: payload.search_sites,
            total_urls_scraped: e.summary.totalUrlsScraped,
            urls_scraped_by_site: e.summary.urlsScrapedBySite,
          });
          return;
        }
        kafkaLogger.error(`[Job ${payload.job_id}] Unhandled error: ${e}`);
        await publishDone(payload.job_id, 'google-dork', {
          result: 'failed',
          search_sites: payload.search_sites,
          error: String(e),
        });
      }
    });

    kafkaLogger.info('SẴN SÀNG. Đang lắng nghe message Kafka 🎧 topic=social.dork.trigger');
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', resolve);
      process.on('SIGINT', resolve);
    });

  } else {
    logger.info('Starting one-shot mode, reading params from env vars');

    const sites = config.oneShot.sites;
    const dateFrom = config.oneShot.dateFrom;
    const dateTo = config.oneShot.dateTo;

    if (!sites.length || !dateFrom || !dateTo) {
      logger.error('Missing SEARCH_SITES / SEARCH_DATE_FROM / SEARCH_DATE_TO in env');
      process.exit(1);
    }

    const payload = parseDorkTriggerPayload({
      job_id: `oneshot-${Date.now()}`,
      job_type: config.oneShot.runType,
      search_sites: sites,
      date_from: dateFrom,
      date_to: dateTo,
      keyword_ids: config.oneShot.keywordIds,
      search_profile: config.oneShot.searchProfile,
      split_days: config.search.splitDays,
      max_pages: config.search.maxPages,
      time_filter: config.oneShot.timeFilter,
    });

    try {
      await runJob(payload);
    } finally {
      await closeKafka();
      await closeGoogleCrawler();
      await closeDb();
    }
  }
}

main().catch(async (e) => {
  createLogger('main').error(`Unhandled fatal error: ${e}`);
  await closeKafka().catch(() => {});
  await closeKafkaProducer().catch(() => {});
  await closeGoogleCrawler().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
