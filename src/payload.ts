import { GoogleTimeFilter } from './query_builder';
import { normalizeSite } from './platforms';

export type DorkJobType = 'daily' | 'backfill' | 'manual' | 'reconciliation';

export interface DorkTriggerPayload {
  job_id: string;
  job_type: DorkJobType;
  search_sites: string[];
  date_from: string;
  date_to: string;
  time_filter?: GoogleTimeFilter;
  keyword_ids?: number[];
  split_days?: number;
  max_pages?: number;
}

const JOB_TYPES = new Set<DorkJobType>(['daily', 'backfill', 'manual', 'reconciliation']);
const TIME_FILTERS = new Set<GoogleTimeFilter>([
  'any',
  'past_hour',
  'past_24_hours',
  'past_week',
  'past_month',
  'custom',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty`);
  }
  return trimmed;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseDate(value: unknown, field: string): string {
  const date = asTrimmedString(value, field);
  if (!isIsoDate(date)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return date;
}

function parseJobType(value: unknown): DorkJobType {
  const jobType = asTrimmedString(value, 'job_type').toLowerCase() as DorkJobType;
  if (!JOB_TYPES.has(jobType)) {
    throw new Error(`job_type must be one of ${Array.from(JOB_TYPES).join(', ')}`);
  }
  return jobType;
}

function parseTimeFilter(value: unknown): GoogleTimeFilter {
  const timeFilter = asTrimmedString(value, 'time_filter').toLowerCase() as GoogleTimeFilter;
  if (!TIME_FILTERS.has(timeFilter)) {
    throw new Error(`time_filter must be one of ${Array.from(TIME_FILTERS).join(', ')}`);
  }
  return timeFilter;
}

function parseKeywordIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('keyword_ids must be an array of integers');
  }

  const ids = value.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw new Error('keyword_ids must contain positive integers only');
    }
    return item;
  });

  return Array.from(new Set(ids));
}

function parseSplitDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('split_days must be a non-negative integer');
  }
  return value;
}

function parseMaxPages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('max_pages must be an integer between 1 and 10');
  }
  return value;
}

function parseSites(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('search_sites must be an array of strings');
  }

  const sites = value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new Error('search_sites must contain strings only');
      }
      return normalizeSite(item);
    })
    .filter(Boolean);

  if (sites.length === 0) {
    throw new Error('search_sites must not be empty');
  }

  return Array.from(new Set(sites));
}

export function parseDorkTriggerPayload(raw: unknown): DorkTriggerPayload {
  if (!isPlainObject(raw)) {
    throw new Error('payload must be an object');
  }

  const payload: DorkTriggerPayload = {
    job_id: asTrimmedString(raw.job_id, 'job_id'),
    job_type: parseJobType(raw.job_type),
    search_sites: parseSites(raw.search_sites),
    date_from: parseDate(raw.date_from, 'date_from'),
    date_to: parseDate(raw.date_to, 'date_to'),
  };

  if (payload.date_to < payload.date_from) {
    throw new Error('date_to must be greater than or equal to date_from');
  }

  if (raw.time_filter !== undefined && raw.time_filter !== null && raw.time_filter !== '') {
    payload.time_filter = parseTimeFilter(raw.time_filter);
  }

  if (raw.keyword_ids !== undefined && raw.keyword_ids !== null) {
    const keywordIds = parseKeywordIds(raw.keyword_ids);
    if (keywordIds.length > 0) {
      payload.keyword_ids = keywordIds;
    }
  }

  if (raw.split_days !== undefined && raw.split_days !== null) {
    payload.split_days = parseSplitDays(raw.split_days);
  }

  if (raw.max_pages !== undefined && raw.max_pages !== null) {
    payload.max_pages = parseMaxPages(raw.max_pages);
  }

  return payload;
}
