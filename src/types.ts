// Shared crawler-facing types.
//
// Kept separate from the Playwright implementation so DB/Kafka orchestration
// and browser discovery share a small, stable contract.

/** One discovered SERP result handed to onResults. */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** Search engine that produced the URL. Used for log/debug only. */
  source: string;
  /** SERP has no engagement concept. Always ''. */
  engagement: string;
}

/** Insert callback: returns number of rows actually inserted (post-dedup). */
export type OnResultsCallback = (results: SearchResult[], query: string) => Promise<number>;

/** Per-page progress tick for job-level heartbeats/monitoring. */
export interface CrawlerProgress {
  query: string;
  page: number;
  found: number;
  inserted: number;
  duplicates: number;
  hasNextPage: boolean;
}

/** Aggregate stats returned by a SERP run. */
export interface CrawlerStats {
  totalQueries: number;
  totalFound: number;
  totalInserted: number;
  totalDuplicates: number;
  failedQueries: string[];
  blockedQueries: string[];
}
