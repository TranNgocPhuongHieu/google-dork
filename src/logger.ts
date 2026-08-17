import { logLevel, LogEntry } from 'kafkajs';
import { config, LogFormat } from './config';

const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type Level = keyof typeof LEVEL_RANK;
const HCM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const HCM_TIME_ZONE_OFFSET = '+07:00';

function currentRank(): number {
  return LEVEL_RANK[config.log.level] ?? LEVEL_RANK.INFO;
}

function formatHcmParts(date: Date, includeFractionalSecond = false): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: HCM_TIME_ZONE,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(includeFractionalSecond ? { fractionalSecondDigits: 3 } : {}),
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: parts.year ?? '1970',
    month: parts.month ?? '01',
    day: parts.day ?? '01',
    hour: parts.hour ?? '00',
    minute: parts.minute ?? '00',
    second: parts.second ?? '00',
    fractionalSecond: parts.fractionalSecond ?? '000',
  };
}

export function formatHcmTextTimestamp(date: Date = new Date()): string {
  const parts = formatHcmParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatHcmIsoTimestamp(date: Date = new Date()): string {
  const parts = formatHcmParts(date, true);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${HCM_TIME_ZONE_OFFSET}`;
}

function currentFormat(): LogFormat {
  return config.log.format;
}

function emit(level: Level, context: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < currentRank()) return;
  const out = level === 'ERROR' ? process.stderr : process.stdout;

  if (currentFormat() === 'json') {
    const obj: Record<string, unknown> = {
      ts: formatHcmIsoTimestamp(),
      timezone: HCM_TIME_ZONE,
      level,
      context,
      msg,
      ...(fields ?? {}),
    };
    out.write(JSON.stringify(obj) + '\n');
    return;
  }

  const extra = fields && Object.keys(fields).length > 0 ? ` | ${JSON.stringify(fields)}` : '';
  const line = `${formatHcmTextTimestamp()} [${level}] ${context} -- ${msg}${extra}`;
  out.write(line + '\n');
}

export function createLogger(context: string, baseFields?: Record<string, unknown>) {
  return {
    info:    (msg: string, fields?: Record<string, unknown>) => emit('INFO',  context, msg, { ...(baseFields ?? {}), ...(fields ?? {}) }),
    warning: (msg: string, fields?: Record<string, unknown>) => emit('WARN',  context, msg, { ...(baseFields ?? {}), ...(fields ?? {}) }),
    warn:    (msg: string, fields?: Record<string, unknown>) => emit('WARN',  context, msg, { ...(baseFields ?? {}), ...(fields ?? {}) }),
    error:   (msg: string, fields?: Record<string, unknown>) => emit('ERROR', context, msg, { ...(baseFields ?? {}), ...(fields ?? {}) }),
    debug:   (msg: string, fields?: Record<string, unknown>) => emit('DEBUG', context, msg, { ...(baseFields ?? {}), ...(fields ?? {}) }),
  };
}

// Default logger kept for backward-compat imports that haven't been migrated
export const logger = createLogger('app');

/**
 * Emit a single structured job-received line so monitoring can parse it.
 */
export function logJobReceived(context: string, payload: object): void {
  const raw = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  const keys = ['job_id', 'job_type', 'search_sites', 'date_from', 'date_to', 'time_filter', 'split_days'];

  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) {
      summary[key] = raw[key];
    }
  }

  if (Array.isArray(raw.search_sites)) {
    summary.search_sites_count = raw.search_sites.length;
  }
  if (Array.isArray(raw.keyword_ids)) {
    summary.keyword_ids_count = raw.keyword_ids.length;
    summary.keyword_ids = raw.keyword_ids;
  }

  emit('INFO', context, 'job_received', summary);
  if (config.log.level === 'DEBUG') {
    emit('DEBUG', context, 'job_received_payload', { payload: raw });
  }
}

// ─── KafkaJS logCreator — suppress internal noise ────────────────────────────

const KAFKA_SUPPRESS_PATTERNS = [
  'Response Metadata',
  'Response Fetch',
  'Response Heartbeat',
  'Response GroupCoordinator',
  'Response OffsetFetch',
  'Response FindCoordinator',
  'Response JoinGroup',
  'Response SyncGroup',
  'Response LeaveGroup',
];

const kafkaInternalLogger = createLogger('kafka');

export function kafkaLogCreator(_level: logLevel) {
  return (entry: LogEntry) => {
    const { level, log: content } = entry;

    if (level === logLevel.ERROR) {
      const msg: string = content.message ?? '';
      if (KAFKA_SUPPRESS_PATTERNS.some((p) => msg.startsWith(p))) return;
      if (msg.includes('Offset out of range')) {
        kafkaInternalLogger.warning(msg);
        return;
      }
      kafkaInternalLogger.error(msg);
      return;
    }

    if (level === logLevel.INFO) {
      const msg: string = content.message ?? '';
      if (msg.includes('Consumer has joined the group')) {
        const groupId: string = (content as any).groupId ?? '';
        const assignment: Record<string, unknown> = (content as any).memberAssignment ?? {};
        const topics = Object.keys(assignment).join(', ') || 'social.dork.trigger';
        kafkaInternalLogger.info(`Consumer joined group="${groupId}" topics="${topics}"`);
      }
    }
    // WARN → silently dropped
  };
}
