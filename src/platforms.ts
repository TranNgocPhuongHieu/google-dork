import { getProvince } from './entity_registry';

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

/**
 * Build one accuracy-first query body per province/site. The site operator,
 * URL exclusions and date operators are added by the query builder.
 */
export function buildSiteSearchTexts(site: string, slug: string): string[] {
  const s = normalizeSite(site);
  if (!['facebook.com', 'instagram.com', 'tiktok.com'].includes(s)) return [];
  const aliases = getSearchAliases(slug);
  if (aliases.length === 0) return [];
  return [
    `${buildOrGroup(aliases)} "du lịch" ${buildNegativeTerms(COMMERCIAL_NEGATIVES)}`.normalize('NFC'),
  ];
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
