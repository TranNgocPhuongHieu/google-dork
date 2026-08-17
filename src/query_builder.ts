import { buildSearchText, normalizeSite } from './platforms';
export { buildSearchText, normalizeSite } from './platforms';

export type GoogleTimeFilter = 'any' | 'past_hour' | 'past_24_hours' | 'past_week' | 'past_month' | 'custom';
export type DateQueryMode = 'rolling' | 'bounded';

export interface BuiltQuery {
    query: string;
    searchText: string;
    site: string;
    keyword: string;
    weekLabel: string;
    dateFrom: string;
    dateTo: string;
    contentFrom: string;
    contentTo: string;
}

function buildBaseQuery(site: string, keyword: string): string {
    const s = normalizeSite(site);
    return `site:${s} ${buildSearchText(s, keyword)}`;
}

export function buildSingleQuery(
    site: string,
    keyword: string,
    dateFrom: string,
    dateTo: string,
    timeFilter: GoogleTimeFilter = 'custom',
    dateMode: DateQueryMode = 'bounded',
): string {
    const baseQuery = buildBaseQuery(site, keyword);
    // For relative filters we do NOT append after/before tokens.
    // (Google time filter will be applied via tbs=qdr:* in the search URL.)
    if (timeFilter && timeFilter !== 'custom') return baseQuery;
    return dateMode === 'rolling'
        ? `${baseQuery} after:${dateFrom}`
        : `${baseQuery} after:${dateFrom} before:${dateTo}`;
}

export interface DateChunk {
    /** exclusive lower bound (start − 1) for Google `after:` operator */
    after: string;
    /** exclusive upper bound (end + 1) for Google `before:` operator */
    before: string;
    /** real inclusive content range start (= chunk start) */
    contentFrom: string;
    /** real inclusive content range end (= chunk end) */
    contentTo: string;
}

export function splitDateRange(dateFrom: string, dateTo: string, splitDays: number = 4): DateChunk[] {
    const start = new Date(dateFrom);
    const end = new Date(dateTo);
    const chunks: DateChunk[] = [];

    let current = new Date(start);
    const daysPerChunk = Math.max(1, splitDays);

    while (current <= end) {
        const chunkEnd = new Date(current);
        chunkEnd.setDate(current.getDate() + daysPerChunk - 1);
        const actualEnd = chunkEnd < end ? chunkEnd : end;

        // after is exclusive, before is exclusive
        const afterDate = new Date(current);
        afterDate.setDate(current.getDate() - 1);

        const beforeDate = new Date(actualEnd);
        beforeDate.setDate(actualEnd.getDate() + 1);

        chunks.push({
            after: afterDate.toISOString().split('T')[0],   // start − 1 (exclusive)
            before: beforeDate.toISOString().split('T')[0],  // end + 1   (exclusive)
            contentFrom: current.toISOString().split('T')[0],   // = start (inclusive)
            contentTo: actualEnd.toISOString().split('T')[0],   // = end   (inclusive)
        });

        current = new Date(actualEnd);
        current.setDate(current.getDate() + 1);
    }
    return chunks;
}

export function buildQueries(
    sites: string[],
    keyword: string,
    dateFrom: string,
    dateTo: string,
    splitDays: number = 4,
    timeFilter: GoogleTimeFilter = 'custom',
    dateMode: DateQueryMode = 'bounded',
) {
    // `dateFrom`/`dateTo` are the exclusive bounds embedded in the dork;
    // `contentFrom`/`contentTo` retain the inclusive job window for reporting.
    const queries: BuiltQuery[] = [];

    for (const site of sites) {
        const normSite = normalizeSite(site);
        const searchText = buildSearchText(normSite, keyword);
        // If using a relative/Google time filter, we must not split by date range.
        // Return a single query per site.
        if (timeFilter && timeFilter !== 'custom') {
            queries.push({
                query: buildSingleQuery(normSite, keyword, dateFrom, dateTo, timeFilter),
                searchText,
                site: normSite,
                keyword,
                dateFrom,
                dateTo,
                // relative filter: runner derives the range from timeFilter; fill for type completeness
                contentFrom: dateFrom,
                contentTo: dateTo,
                weekLabel: String(timeFilter),
            });
            continue;
        }

        if (dateMode === 'rolling') {
            const afterDate = new Date(`${dateFrom}T00:00:00Z`);
            afterDate.setUTCDate(afterDate.getUTCDate() - 1);
            const after = afterDate.toISOString().split('T')[0];
            queries.push({
                query: buildSingleQuery(normSite, keyword, after, dateTo, timeFilter, dateMode),
                searchText,
                site: normSite,
                keyword,
                dateFrom: after,
                dateTo,
                contentFrom: dateFrom,
                contentTo: dateTo,
                weekLabel: 'ROLLING',
            });
        } else if (splitDays > 0) {
            const chunks = splitDateRange(dateFrom, dateTo, splitDays);
            chunks.forEach((chunk, i) => {
                queries.push({
                    query: buildSingleQuery(normSite, keyword, chunk.after, chunk.before, timeFilter, dateMode),
                    searchText,
                    site: normSite,
                    keyword,
                    dateFrom: chunk.after,
                    dateTo: chunk.before,
                    contentFrom: chunk.contentFrom, // inclusive real range
                    contentTo: chunk.contentTo,
                    weekLabel: `P${i + 1}`
                });
            });
        } else {
            const afterDate = new Date(dateFrom);
            afterDate.setDate(afterDate.getDate() - 1);
            const beforeDate = new Date(dateTo);
            beforeDate.setDate(beforeDate.getDate() + 1);

            queries.push({
                query: buildSingleQuery(normSite, keyword, afterDate.toISOString().split('T')[0], beforeDate.toISOString().split('T')[0], timeFilter, dateMode),
                searchText,
                site: normSite,
                keyword,
                dateFrom: afterDate.toISOString().split('T')[0],
                dateTo: beforeDate.toISOString().split('T')[0],
                contentFrom: dateFrom, // raw inclusive (NOT the ±1-shifted values)
                contentTo: dateTo,
                weekLabel: "ALL"
            });
        }
    }
    return queries;
}
