// Discovery registry for Vietnam 2025 provincial units plus supported foreign
// city destinations carried in dim_keyword.
//
// Split of concerns: `dim_keyword` (DB) holds ONLY province name + slug; the
// per-site search strategy (place entities for FB/TikTok, VN-travel hashtags for
// IG, tier/budget) lives here in code.
//
// Measured rationale (Google site: caps ~7-9 results/query, no pagination):
//   - FB: `"{place entity}" "{phrase}"` — ~90% relevant on tourism provinces.
//     Discussion = BOTH reviews/experience AND Q&A, so the phrase set mixes
//     review words (review/kinh nghiệm/trải nghiệm/đánh giá) with question words
//     (cho mình hỏi/có nên). Ads evade keyword-negatives (Unicode font) but can't
//     fake these natural phrases.
//   - IG: curated VN-travel hashtags (`#dulich<tỉnh>` ~80%; bare `#<tỉnh>` ~55%).
//   - TikTok via Google ≈ 0% usable → minimal, Tier-A only.
//
// ⚠️ NEEDS REVIEW: the 2025 merger mapping, tier assignments, and POI/hashtag
// lists are a best-effort proposal — verify against the official list and tune.

export type Tier = 'A' | 'B' | 'C';

export interface ProvinceEntry {
  slug: string; // matches dim_keyword.province (ASCII slug)
  name: string; // display name (logs/attribution)
  tier: Tier;
  placeEntities: string[]; // FB/TikTok: place names (province + famous POIs + merged sub-regions)
  igHashtags: string[]; // IG: hashtag bodies WITHOUT leading '#'
}

// Conversational phrases — the FB "hashtag-equivalent". Reviews + Q&A both.
// NOTE: bare "review" is intentionally excluded — it matches review-GROUP names
// ("X Review Tất Tần Tật") which are landing pages filtered out as non-posts.
// Review/experience content is captured efficiently by body-level phrases below
// ("vừa đi", "đáng đi", "kinh nghiệm", "trải nghiệm").
const REVIEW_PHRASES = ['kinh nghiệm', 'trải nghiệm', 'vừa đi', 'đáng đi', 'lịch trình'];
const QUESTION_PHRASES = ['cho mình hỏi', 'có nên'];
const EXTENDED_PHRASES = ['đánh giá', 'chia sẻ', 'tư vấn', 'ăn gì', 'chuyến đi'];

export const INTENT_PHRASES_CORE = [...REVIEW_PHRASES, ...QUESTION_PHRASES];

/**
 * Phrase set per tier. Tier C (thin provinces) uses review-only phrases — the
 * broad question phrases ("có nên"/"cho mình hỏi") drift to real-estate/local-
 * life there (measured), while review/experience phrases stay tourism-anchored.
 */
export function intentPhrasesForTier(tier: Tier): string[] {
  if (tier === 'A') return [...INTENT_PHRASES_CORE, ...EXTENDED_PHRASES];
  if (tier === 'B') return INTENT_PHRASES_CORE;
  return REVIEW_PHRASES; // Tier C: review-leaning only
}

// ── Helpers to keep the table compact ──────────────────────────────────────
function A(slug: string, name: string, placeEntities: string[], igHashtags: string[]): ProvinceEntry {
  return { slug, name, tier: 'A', placeEntities, igHashtags };
}
function B(slug: string, name: string, placeEntities: string[], igHashtags: string[]): ProvinceEntry {
  return { slug, name, tier: 'B', placeEntities, igHashtags };
}
function C(slug: string, name: string, placeEntities: string[], igHashtags: string[]): ProvinceEntry {
  return { slug, name, tier: 'C', placeEntities, igHashtags };
}

const ALL: ProvinceEntry[] = [
  // ───────────── TIER A — trọng điểm du lịch (detail nhiều) ─────────────
  A('ha_noi', 'Hà Nội',
    ['Hà Nội', 'Hồ Gươm', 'Phố Cổ Hà Nội', 'Hồ Tây', 'Văn Miếu', 'Hoàng Thành Thăng Long', 'Lăng Bác', 'Ba Vì', 'chùa Hương', 'làng cổ Đường Lâm'],
    ['dulichhanoi', 'hanoitravel', 'reviewhanoi', 'anchoihanoi', 'hanoifood', 'phocohanoi', 'checkinhanoi']),
  A('hcmc', 'TP.HCM',
    ['TP.HCM', 'Sài Gòn', 'Vũng Tàu', 'Côn Đảo', 'Hồ Tràm', 'chợ Bến Thành', 'phố Bùi Viện', 'Nhà thờ Đức Bà', 'Landmark 81', 'Cần Giờ', 'Bình Dương'],
    ['dulichsaigon', 'saigontravel', 'reviewsaigon', 'anchoisaigon', 'saigonfood', 'dulichvungtau', 'condao']),
  A('da_nang', 'Đà Nẵng',
    ['Đà Nẵng', 'Bà Nà Hills', 'Hội An', 'Mỹ Khê', 'Sơn Trà', 'Ngũ Hành Sơn', 'Cầu Rồng', 'Cù Lao Chàm', 'Mỹ Sơn', 'đèo Hải Vân', 'Quảng Nam'],
    ['dulichdanang', 'danangtravel', 'reviewdanang', 'anchoidanang', 'danangfood', 'hoian', 'banahills']),
  A('hue', 'Huế',
    ['Huế', 'Đại Nội Huế', 'Kinh thành Huế', 'sông Hương', 'chùa Thiên Mụ', 'lăng Khải Định', 'lăng Tự Đức', 'Bạch Mã', 'Lăng Cô', 'biển Thuận An'],
    ['dulichhue', 'huetravel', 'reviewhue', 'anchoihue', 'huefood', 'dainoihue']),
  A('lam_dong', 'Lâm Đồng',
    ['Đà Lạt', 'Langbiang', 'hồ Tuyền Lâm', 'thác Datanla', 'thung lũng Tình Yêu', 'đồi chè Cầu Đất', 'Mũi Né', 'Phan Thiết', 'Bàu Trắng', 'Tà Đùng'],
    ['dulichdalat', 'dalattravel', 'reviewdalat', 'anchoidalat', 'dalatfood', 'muine', 'phanthiet']),
  A('khanh_hoa', 'Khánh Hòa',
    ['Nha Trang', 'Khánh Hòa', 'Vinpearl Nha Trang', 'đảo Bình Ba', 'Vĩnh Hy', 'Dốc Lết', 'Cam Ranh', 'Bãi Dài', 'Ninh Thuận', 'Phan Rang'],
    ['dulichnhatrang', 'nhatrangtravel', 'reviewnhatrang', 'anchoinhatrang', 'nhatrangfood', 'vinhhy']),
  A('quang_ninh', 'Quảng Ninh',
    ['Hạ Long', 'Vịnh Hạ Long', 'Bãi Cháy', 'Cô Tô', 'Quan Lạn', 'Yên Tử', 'Bình Liêu', 'Tuần Châu', 'Móng Cái'],
    ['dulichhalong', 'halongbay', 'reviewhalong', 'anchoihalong', 'coto', 'quangninh']),
  A('ninh_binh', 'Ninh Bình',
    ['Ninh Bình', 'Tràng An', 'Tam Cốc', 'Hang Múa', 'Bái Đính', 'Cúc Phương', 'đầm Vân Long', 'Nam Định', 'Hà Nam'],
    ['dulichninhbinh', 'ninhbinhtravel', 'reviewninhbinh', 'trangan', 'tamcoc', 'hangmua']),
  A('lao_cai', 'Lào Cai',
    ['Sa Pa', 'Lào Cai', 'Fansipan', 'Y Tý', 'Bắc Hà', 'Mù Cang Chải', 'Nghĩa Lộ', 'đỉnh Lảo Thẩn', 'Yên Bái'],
    ['dulichsapa', 'sapatravel', 'reviewsapa', 'mucangchai', 'fansipan', 'yty']),
  A('an_giang', 'An Giang',
    ['Phú Quốc', 'An Giang', 'Châu Đốc', 'Núi Cấm', 'rừng tràm Trà Sư', 'Hà Tiên', 'Nam Du', 'Hòn Sơn', 'miếu Bà Chúa Xứ', 'Kiên Giang'],
    ['dulichphuquoc', 'phuquoctravel', 'reviewphuquoc', 'anchoiphuquoc', 'chaudoc', 'hatien', 'namdu']),
  A('gia_lai', 'Gia Lai',
    ['Quy Nhơn', 'Gia Lai', 'Bình Định', 'Kỳ Co', 'Eo Gió', 'Pleiku', 'Biển Hồ', 'Ghềnh Ráng', 'Hầm Hô'],
    ['dulichquynhon', 'quynhontravel', 'reviewquynhon', 'kyco', 'eogio', 'pleiku']),
  A('tuyen_quang', 'Tuyên Quang',
    ['Hà Giang', 'Tuyên Quang', 'Đồng Văn', 'Mã Pí Lèng', 'Lũng Cú', 'sông Nho Quế', 'cao nguyên đá', 'Hoàng Su Phì', 'Na Hang'],
    ['dulichhagiang', 'hagiang', 'hagiangloop', 'reviewhagiang', 'dongvan', 'mapileng']),

  // ───────────── TIER B — du lịch trung bình ─────────────
  B('hai_phong', 'Hải Phòng',
    ['Hải Phòng', 'Cát Bà', 'Đồ Sơn', 'đảo Cát Bà', 'Hải Dương', 'Côn Sơn Kiếp Bạc'],
    ['dulichhaiphong', 'catba', 'reviewhaiphong', 'haiphongfood']),
  B('can_tho', 'Cần Thơ',
    ['Cần Thơ', 'chợ nổi Cái Răng', 'bến Ninh Kiều', 'cồn Sơn', 'Sóc Trăng', 'Hậu Giang'],
    ['dulichcantho', 'canthotravel', 'reviewcantho', 'chonoicairang']),
  B('thanh_hoa', 'Thanh Hóa',
    ['Thanh Hóa', 'Sầm Sơn', 'Pù Luông', 'suối cá Cẩm Lương', 'biển Hải Tiến', 'thành nhà Hồ'],
    ['dulichthanhhoa', 'samson', 'puluong', 'reviewthanhhoa']),
  B('nghe_an', 'Nghệ An',
    ['Nghệ An', 'Cửa Lò', 'quê Bác', 'Pù Mát', 'đảo Lan Châu', 'Mường Lống'],
    ['dulichnghean', 'cualo', 'reviewnghean']),
  B('quang_tri', 'Quảng Trị',
    ['Phong Nha', 'Quảng Bình', 'Đồng Hới', 'động Thiên Đường', 'Sơn Đoòng', 'Quảng Trị', 'Cồn Cỏ', 'thành cổ Quảng Trị'],
    ['dulichquangbinh', 'phongnha', 'dongthienduong', 'reviewquangbinh', 'quangtri']),
  B('quang_ngai', 'Quảng Ngãi',
    ['Lý Sơn', 'Quảng Ngãi', 'Kon Tum', 'Măng Đen', 'biển Sa Huỳnh', 'đảo Bé'],
    ['dulichlyson', 'lyson', 'mangden', 'reviewquangngai']),
  B('dak_lak', 'Đắk Lắk',
    ['Buôn Ma Thuột', 'Đắk Lắk', 'hồ Lắk', 'thác Dray Nur', 'Phú Yên', 'Tuy Hòa', 'Gành Đá Đĩa', 'Bãi Xếp'],
    ['dulichbuonmathuot', 'daklak', 'phuyen', 'ganhdadia', 'tuyhoa']),
  B('tay_ninh', 'Tây Ninh',
    ['Tây Ninh', 'Núi Bà Đen', 'Tòa Thánh Cao Đài', 'hồ Dầu Tiếng', 'Long An', 'làng nổi Tân Lập'],
    ['dulichtayninh', 'nuibaden', 'reviewtayninh']),
  B('cao_bang', 'Cao Bằng',
    ['Cao Bằng', 'thác Bản Giốc', 'động Ngườm Ngao', 'hồ Thang Hen', 'Pác Bó'],
    ['dulichcaobang', 'bangioc', 'reviewcaobang']),
  B('dien_bien', 'Điện Biên',
    ['Điện Biên', 'Điện Biên Phủ', 'A Pa Chải', 'đèo Pha Đin', 'Mường Thanh'],
    ['dulichdienbien', 'dienbienphu', 'reviewdienbien']),
  B('phu_tho', 'Phú Thọ',
    ['Phú Thọ', 'Đền Hùng', 'Tam Đảo', 'Vĩnh Phúc', 'Hòa Bình', 'Mai Châu', 'vườn quốc gia Xuân Sơn'],
    ['dulichphutho', 'tamdao', 'denhung', 'maichau']),
  B('dong_nai', 'Đồng Nai',
    ['Đồng Nai', 'Bình Phước', 'thác Giang Điền', 'núi Chứa Chan', 'vườn quốc gia Cát Tiên', 'hồ Trị An'],
    ['dulichdongnai', 'cattien', 'reviewdongnai']),
  B('son_la', 'Sơn La',
    ['Mộc Châu', 'Sơn La', 'đồi chè Mộc Châu', 'thác Dải Yếm', 'Tà Xùa', 'ngũ động Bản Ôn'],
    ['dulichmocchau', 'mocchau', 'taxua', 'reviewmocchau']),

  // ───────────── TIER C — ít du lịch (IG-leaning) ─────────────
  C('hung_yen', 'Hưng Yên',
    ['Hưng Yên', 'Phố Hiến', 'Thái Bình', 'biển Cồn Vành'],
    ['dulichhungyen', 'phohien']),
  C('bac_ninh', 'Bắc Ninh',
    ['Bắc Ninh', 'Bắc Giang', 'đền Đô', 'chùa Bút Tháp', 'Tây Yên Tử'],
    ['dulichbacninh', 'denbo']),
  C('vinh_long', 'Vĩnh Long',
    ['Vĩnh Long', 'Bến Tre', 'Trà Vinh', 'cồn Phụng', 'cù lao An Bình'],
    ['dulichvinhlong', 'dulichbentre']),
  C('dong_thap', 'Đồng Tháp',
    ['Đồng Tháp', 'Tiền Giang', 'Sa Đéc', 'Tràm Chim', 'làng hoa Sa Đéc', 'Mỹ Tho'],
    ['dulichdongthap', 'sadec', 'tramchim']),
  C('ca_mau', 'Cà Mau',
    ['Cà Mau', 'Bạc Liêu', 'Mũi Cà Mau', 'đất Mũi', 'nhà công tử Bạc Liêu', 'U Minh'],
    ['dulichcamau', 'muicamau', 'baclieu']),
  C('lang_son', 'Lạng Sơn',
    ['Lạng Sơn', 'Mẫu Sơn', 'động Tam Thanh', 'Bắc Sơn'],
    ['dulichlangson', 'mauson', 'bacson']),
  C('thai_nguyen', 'Thái Nguyên',
    ['Thái Nguyên', 'Bắc Kạn', 'hồ Ba Bể', 'hồ Núi Cốc', 'ATK Định Hóa'],
    ['dulichthainguyen', 'babe']),
  C('ha_tinh', 'Hà Tĩnh',
    ['Hà Tĩnh', 'biển Thiên Cầm', 'chùa Hương Tích', 'đèo Ngang'],
    ['dulichhatinh', 'thiencam']),
  C('lai_chau', 'Lai Châu',
    ['Lai Châu', 'Pu Ta Leng', 'Sìn Hồ', 'đèo Ô Quy Hồ', 'Sin Suối Hồ'],
    ['dulichlaichau', 'putaleng']),

  // ───────────── FOREIGN DESTINATIONS ─────────────
  B('tokyo', 'Tokyo', ['Tokyo', 'Shibuya', 'Shinjuku', 'Asakusa', 'Tokyo Tower', 'Ueno'], ['tokyo', 'tokyotravel']),
  B('kyoto', 'Kyoto', ['Kyoto', 'Gion', 'Arashiyama', 'Fushimi Inari', 'Kiyomizu dera'], ['kyoto', 'kyototravel']),
  B('osaka', 'Osaka', ['Osaka', 'Dotonbori', 'Shinsaibashi', 'Osaka Castle', 'Namba'], ['osaka', 'osakatravel']),
  B('seoul', 'Seoul', ['Seoul', 'Myeongdong', 'Hongdae', 'Itaewon', 'Gyeongbokgung'], ['seoul', 'seoultravel']),
  B('busan', 'Busan', ['Busan', 'Haeundae', 'Gamcheon', 'Jagalchi', 'Gwangalli'], ['busan', 'busantravel']),
  B('jeju', 'Jeju', ['Jeju', 'Seongsan Ilchulbong', 'Hallasan', 'Aewol', 'Hamdeok'], ['jeju', 'jejutravel']),
  B('beijing', 'Beijing', ['Beijing', 'Forbidden City', 'Wangfujing', 'Temple of Heaven', 'Mutianyu'], ['beijing', 'beijingtravel']),
  B('shanghai', 'Shanghai', ['Shanghai', 'The Bund', 'Lujiazui', 'Nanjing Road', 'Xintiandi'], ['shanghai', 'shanghaitravel']),
  B('guangzhou', 'Guangzhou', ['Guangzhou', 'Canton Tower', 'Shamian', 'Beijing Road', 'Tianhe'], ['guangzhou', 'guangzhoutravel']),
  B('bangkok', 'Bangkok', ['Bangkok', 'Chatuchak', 'Siam', 'Yaowarat', 'Wat Arun'], ['bangkok', 'bangkoktravel']),
  B('chiangmai', 'Chiang Mai', ['Chiang Mai', 'Nimman', 'Doi Suthep', 'Old City', 'Mae Kampong'], ['chiangmai', 'chiangmaitravel']),
  B('phuket', 'Phuket', ['Phuket', 'Patong', 'Old Town Phuket', 'Kata Beach', 'Promthep'], ['phuket', 'phukettravel']),
  B('singapore', 'Singapore', ['Singapore', 'Marina Bay', 'Sentosa', 'Chinatown Singapore', 'Gardens by the Bay'], ['singapore', 'singaporetravel']),
];

export const REGISTRY: Record<string, ProvinceEntry> = Object.fromEntries(
  ALL.map((p) => [p.slug, p]),
);

export function getProvince(slug: string): ProvinceEntry | undefined {
  return REGISTRY[slug];
}
