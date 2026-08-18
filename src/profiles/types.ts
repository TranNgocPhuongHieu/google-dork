// Kiểu dùng chung cho mọi search profile. KHÔNG chứa dữ liệu ngôn ngữ nào.

export type CadenceGroup = 'core' | 'mid' | 'long';

export interface CadenceSpec {
  /** Bao nhiêu ngày cào lại một lần. */
  cadenceDays: number;
  /** Cửa sổ after:/before:. LUÔN > cadenceDays để chồng lấn, bù độ trễ index
   *  của Google. Chồng lấn KHÔNG tốn thêm query — cửa sổ chỉ là toán tử. */
  windowDays: number;
}

export interface PlaceEntry {
  name: string;
  /** PHẢI khớp dim_keyword.province. fact_post.keyword_id ở cấp tỉnh và
   *  insertPosts() KHÔNG re-attribution — gán sai là sai vĩnh viễn. */
  provinceSlug: string;
  cadence: CadenceGroup;
}

export interface ProfileSpec {
  id: string;
  /** Bảng địa điểm riêng của profile. Rỗng + useLegacyRegistry=true thì đọc
   *  entity_registry.ts như luồng cũ. */
  places: PlaceEntry[];
  cadence: Record<CadenceGroup, CadenceSpec>;
  /** Trần số page theo tier tỉnh × nhóm cadence. Vắng = dùng env tier caps cũ. */
  pageDepth?: Record<'A' | 'B' | 'C', Record<CadenceGroup, number>>;
  /** OR-group cụm intent. null = dùng intentLiteral. */
  intentGroups: string[][] | null;
  /** Literal đơn (vi_legacy dùng "du lịch"). null nếu đã có intentGroups. */
  intentLiteral: string | null;
  /** Negative term thêm vào body query. EN để rỗng vì ngân sách token đã kín. */
  commercialNegatives: string[];
  /** Optional site-specific override, keyed by normalized site domain. */
  commercialNegativesBySite?: Record<string, string[]>;
  /** Số địa điểm gộp trong một OR-group. */
  placesPerQuery: number;
  /** Site profile này chạy. */
  sites: string[];
  /** true = bỏ qua places, dùng entity_registry (chỉ vi_legacy). */
  useLegacyRegistry?: boolean;
}
