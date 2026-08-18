import { getProvince } from './entity_registry';
import { chunkPlaces } from './place_scheduler';
import { getProfile, SearchProfile } from './profiles';
import { PlaceEntry } from './profiles/types';

export const SITE_ALIASES: Record<string, string> = {
  facebook: 'facebook.com',
  fb: 'facebook.com',
  instagram: 'instagram.com',
  ig: 'instagram.com',
  twitter: 'x.com',
  x: 'x.com',
  tiktok: 'tiktok.com',
  tt: 'tiktok.com',
  threads: 'threads.com',
  th: 'threads.com',
};

const COMMERCIAL_NEGATIVES = [
  'combo',
  'booking',
  'hotline',
  'liên hệ',
  'zalo',
  'sđt',
  'inbox',
  'ib',
  'tour',
  'báo giá',
];
const SITE_URL_NEGATIVES: Record<string, string[]> = {
  'facebook.com': ['-inurl:photo', '-inurl:photos'],
  'instagram.com': ['-inurl:explore', '-inurl:stories', '-inurl:accounts'],
  'tiktok.com': ['-inurl:tag', '-inurl:discover', '-inurl:search', '-site:shop.tiktok.com'],
};
/** Hard cap for the complete Google query, including operators/date reserve. */
export const QUERY_WORD_BUDGET = 32;
/** Place profiles keep each intent group intact after budget fallback. */
export const MAX_CHUNKS_PER_GROUP = 1;
const SITE_OPERATOR_WORDS = 1;
const DATE_RESERVE_WORDS = 2;
const PLACE_LIMIT_BY_TIER = { A: 4, B: 3, C: 2 } as const;
const NOISY_ALIAS_DENYLIST = new Set(['Bà Nà Hills', 'Vinpearl Nha Trang', 'thác Datanla', 'Landmark 81']);
const MATH_BOLD = /[\u{1D400}-\u{1D7FF}]/u;
const PRICE = /\d{2,}\s?(k|tr|đ|vnđ|vnd|nghìn|triệu|ngàn)\b/i;
const PHONE = /(^|\D)0\d{8,10}(\D|$)/;
const COMMERCE = /(?:voucher|combo|khuyến mãi|khuyến mại|inbox|booking|đặt phòng|đặt tour|liên hệ|ưu đãi|giảm giá|đặt ngay|\bdeal\b|\bsale\b|pass phòng|còn phòng|nhận đặt|hotline|giá rẻ|zalo|sđt|ib\b|báo giá)/i;

export function normalizeSite(site: string): string {
  const s = site.toLowerCase().trim();
  return SITE_ALIASES[s] || s;
}

export function buildSearchText(site: string, keyword: string): string {
  const normalizedSite = normalizeSite(site);
  const suffix = SITE_URL_NEGATIVES[normalizedSite] ?? [];
  return `${keyword.trim()} ${suffix.join(' ')}`.trim().normalize('NFC');
}

function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '\\"')}"`;
}

function buildOrGroup(terms: string[]): string {
  return `(${terms.map(quoteTerm).join(' OR ')})`;
}

/**
 * Count Google's whitespace-delimited query words using the project's budget
 * convention. Parentheses and quotes are syntax, while OR remains a word.
 */
export function countQueryWords(query: string): number {
  const stripped = query.replace(/[()\"]/g, '').trim();
  return stripped ? stripped.split(/\s+/).length : 0;
}

function queryOverheadWords(site: string): number {
  const normalizedSite = normalizeSite(site);
  return (
    SITE_OPERATOR_WORDS +
    (SITE_URL_NEGATIVES[normalizedSite]?.length ?? 0) +
    DATE_RESERVE_WORDS
  );
}

function fitsQueryBudget(site: string, body: string): boolean {
  return countQueryWords(body) + queryOverheadWords(site) <= QUERY_WORD_BUDGET;
}

function buildNegativeTerms(terms: string[]): string {
  return terms
    .map((term) => {
      if (term.startsWith('-')) return term;
      return /\s/.test(term) ? `-${quoteTerm(term)}` : `-${term}`;
    })
    .join(' ');
}

function uniqueTerms(terms: string[]): string[] {
  return Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean)));
}

function getSearchAliases(slug: string): string[] {
  const prov = getProvince(slug);
  if (!prov) return [];
  return uniqueTerms(prov.placeEntities.filter((term) => !NOISY_ALIAS_DENYLIST.has(term)))
    .slice(0, PLACE_LIMIT_BY_TIER[prov.tier])
    .map((term) => term.normalize('NFC'));
}

function buildIntentGroup(terms: string[]): string {
  return buildOrGroup(uniqueTerms(terms));
}

function commercialNegativesForSite(
  profile: ReturnType<typeof getProfile>,
  site: string,
): string[] {
  const normalizedSite = normalizeSite(site);
  return profile.commercialNegativesBySite?.[normalizedSite] ?? profile.commercialNegatives;
}

function buildBodiesForPlaceGroup(
  site: string,
  spec: ReturnType<typeof getProfile>,
  places: PlaceEntry[],
  commercialNegatives: string[],
): string[] | null {
  const names = uniqueTerms(places.map((place) => place.name.normalize('NFC')));
  if (names.length === 0) return null;
  const placesGroup = buildOrGroup(names);
  const negatives = buildNegativeTerms(commercialNegatives);
  const suffix = negatives ? ` ${negatives}` : '';

  if (spec.intentGroups && spec.intentGroups.length > 0) {
    const bodies = spec.intentGroups.map((terms) => {
      const normalizedTerms = uniqueTerms(terms);
      return `${placesGroup} ${buildIntentGroup(normalizedTerms)}${suffix}`.trim().normalize('NFC');
    });
    return bodies.length > 0 && bodies.every((body) => fitsQueryBudget(site, body)) ? bodies : null;
  }

  if (!spec.intentLiteral) return null;
  const body = `${placesGroup} ${quoteTerm(spec.intentLiteral)}${suffix}`.trim().normalize('NFC');
  return fitsQueryBudget(site, body) ? [body] : null;
}

function splitPlaceGroup(places: PlaceEntry[], maxPlaces: number): PlaceEntry[][] {
  const groups: PlaceEntry[][] = [];
  for (let i = 0; i < places.length; i += maxPlaces) {
    groups.push(places.slice(i, i + maxPlaces));
  }
  return groups;
}

/**
 * Find the largest place grouping that keeps every literal/intent group within
 * the complete-query word budget. Fallback is deliberately place-only so
 * intent terms and commercial negatives are never discarded.
 */
export function fitPlaceGroupsToBudget(
  site: string,
  profile: SearchProfile,
  places: PlaceEntry[],
): PlaceEntry[][] | null {
  const spec = getProfile(profile);
  const normalizedSite = normalizeSite(site);
  if (!spec.sites.some((candidate) => normalizeSite(candidate) === normalizedSite)) return [];
  if (places.length === 0) return [];

  const commercialNegatives = commercialNegativesForSite(spec, normalizedSite);
  const minimumGroupSize = Math.min(2, places.length);
  for (let maxPlaces = places.length; maxPlaces >= minimumGroupSize; maxPlaces--) {
    const groups = splitPlaceGroup(places, maxPlaces);
    if (groups.every((group) => buildBodiesForPlaceGroup(normalizedSite, spec, group, commercialNegatives))) {
      return groups;
    }
  }

  return null;
}

function buildPlaceSearchTexts(
  site: string,
  profile: SearchProfile,
  places: PlaceEntry[],
): string[] {
  const spec = getProfile(profile);
  const normalizedSite = normalizeSite(site);
  if (!spec.sites.some((candidate) => normalizeSite(candidate) === normalizedSite)) return [];
  const commercialNegatives = commercialNegativesForSite(spec, site);
  const placeGroups = fitPlaceGroupsToBudget(normalizedSite, profile, places);
  if (!placeGroups) {
    const kind = spec.intentLiteral ? 'intent literal' : 'intent groups';
    const names = places.map((place) => place.name).join('|');
    console.warn(
      `[platforms] dropping over-budget ${kind} profile=${profile} site=${normalizedSite} places=${names}`,
    );
    return [];
  }

  return placeGroups.flatMap((group) =>
    buildBodiesForPlaceGroup(normalizedSite, spec, group, commercialNegatives) ?? [],
  );
}

/**
 * Build search bodies for either the unchanged legacy registry path or a
 * profile's selected place chunk. `places` is optional so existing callers
 * retain the exact two/three-argument contract.
 */
export function buildProfileSearchTexts(
  site: string,
  slug: string,
  profile: SearchProfile,
  places?: PlaceEntry[],
): string[] {
  const spec = getProfile(profile);
  if (spec.useLegacyRegistry) {
    return buildLegacySiteSearchTexts(site, slug);
  }
  if (places) return buildPlaceSearchTexts(site, profile, places);

  // Accuracy-probe and other profile callers may not have scheduler output.
  // Use configured chunks first; a group is subdivided only if it cannot fit.
  const provincePlaces = spec.places.filter((place) => place.provinceSlug === slug);
  const chunks = chunkPlaces(provincePlaces, spec.placesPerQuery);
  return chunks.flatMap((chunk) => buildPlaceSearchTexts(site, profile, chunk.places));
}

function buildLegacySiteSearchTexts(site: string, slug: string): string[] {
  const s = normalizeSite(site);
  if (!['facebook.com', 'instagram.com', 'tiktok.com'].includes(s)) return [];
  const aliases = getSearchAliases(slug);
  if (aliases.length === 0) return [];
  return [
    `${buildOrGroup(aliases)} "du lịch" ${buildNegativeTerms(COMMERCIAL_NEGATIVES)}`.normalize('NFC'),
  ];
}

/**
 * Build one accuracy-first query body per province/site. The site operator,
 * URL exclusions and date operators are added by the query builder.
 */
export function buildSiteSearchTexts(
  site: string,
  slug: string,
  profile: SearchProfile = 'vi_legacy',
  places?: PlaceEntry[],
): string[] {
  return buildProfileSearchTexts(site, slug, profile, places);
}

export function extractPostId(url: string, domain: string): string | null {
  try {
    const u = new URL(url);
    if (domain === 'facebook.com') {
      const storyFbid = u.searchParams.get('story_fbid');
      if (storyFbid) return storyFbid;
      const watchV = u.searchParams.get('v');
      if (watchV) return watchV;
      const fbid = u.searchParams.get('fbid');
      if (fbid) return fbid;
      const pfbid = u.pathname.match(/(pfbid[a-zA-Z0-9]+)/);
      if (pfbid) return pfbid[1];
      const segs = u.pathname.split('/').filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        if (/^\d{10,}$/.test(segs[i])) return segs[i];
      }
      return null;
    }
    if (domain === 'instagram.com') {
      const m = u.pathname.match(/\/(p|reel|tv)\/([^/?]+)/);
      return m ? m[2] : null;
    }
    if (domain === 'x.com') {
      const m = u.pathname.match(/\/status\/(\d+)/);
      return m ? m[1] : null;
    }
    if (domain === 'tiktok.com') {
      const m = u.pathname.match(/\/video\/(\d+)/);
      return m ? m[1] : null;
    }
    if (domain === 'threads.com' || domain === 'threads.net') {
      const m = u.pathname.match(/\/post\/([^/?]+)/);
      return m ? m[1] : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function isEligiblePostUrl(url: string, site: string): boolean {
  let pathname: string;
  let search = '';
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();
    search = parsed.search.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }

  if (site === 'facebook.com' || site === 'fb') {
    if (
      pathname.includes('/events/') ||
      pathname.includes('/marketplace/') ||
      pathname.includes('/album/') ||
      pathname.includes('/albums/') ||
      pathname.includes('/media/') ||
      pathname.includes('/media/set/') ||
      pathname.includes('/picture.php') ||
      pathname.includes('/login/') ||
      pathname.includes('/share/') ||
      pathname.includes('/checkpoint/') ||
      pathname.includes('/photo/') ||
      pathname.includes('/photos/') ||
      (pathname.includes('/story.php') && search.includes('fbid=')) ||
      (pathname.includes('/permalink.php') && search.includes('fbid=') && !search.includes('story_fbid=')) ||
      search.includes('set=a.')
    ) {
      return false;
    }

    if (pathname.includes('/posts/')) return true;
    if (pathname.includes('/groups/') && pathname.includes('/permalink/')) return true;
    if (pathname.includes('/story.php') && url.includes('story_fbid')) return true;
    if (pathname.includes('/permalink.php') && url.includes('story_fbid')) return true;
    if (pathname.includes('/pfbid')) return true;
    if (pathname.includes('/reel/')) return true;
    if (pathname.includes('/watch/')) return true;
    if (pathname.includes('/hashtag/')) return true;
    if (pathname.includes('/search/')) return true;

    return false;
  }

  if (site === 'instagram.com' || site === 'ig') {
    if (pathname.includes('/explore/') || pathname.includes('/stories/') || pathname.includes('/accounts/')) {
      return false;
    }
    if (pathname === '/reels/' || pathname === '/reels') return false;
    if (pathname.includes('/p/')) return true;
    if (pathname.includes('/reel/')) return true;
    if (pathname.includes('/tv/')) return true;
    return false;
  }

  if (site === 'x.com' || site === 'twitter') {
    if (pathname.includes('/explore') || pathname.includes('/search')) {
      return false;
    }
    return pathname.includes('/status/');
  }

  if (site === 'tiktok.com' || site === 'tiktok' || site === 'tt') {
    if (pathname.includes('/tag/') || pathname.includes('/discover') || pathname.includes('/search')) {
      return false;
    }
    return pathname.includes('/video/');
  }

  if (site === 'threads.com' || site === 'threads.net' || site === 'threads') {
    if (pathname.includes('/search') || pathname.includes('/explore')) {
      return false;
    }
    return pathname.includes('/post/');
  }

  return true;
}

export function isLikelyAdResult(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.trim();
  if (!text) return false;
  return MATH_BOLD.test(text) || PRICE.test(text) || PHONE.test(text) || COMMERCE.test(text);
}
