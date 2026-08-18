import { PlaceEntry, ProfileSpec } from './types';

// KHUNG MẪU cho ngôn ngữ mới. Copy file này thành <lang>.ts rồi điền.
// Thêm ngôn ngữ = 1 file mới + 1 dòng trong index.ts. KHÔNG sửa file nào khác.
//
// CẢNH BÁO: đừng dịch máy bảng VI hoặc EN sang ngôn ngữ mới.
// Bằng chứng: query EN dịch từ VI ("travel", "tourism", "experience") trả về
// toàn kết quả tiếng Việt. Bản chạy được dùng trục hoàn toàn khác
// ("I stayed", "worth it"). Mỗi ngôn ngữ có cách viết review riêng.
// Ví dụ tiếng Hàn: 다녀왔어요, 후기, 가성비, 숙소 — và địa danh viết Hangul: 다낭, 호이안.
// Bộ cụm phải được kiểm chứng thủ công trên Google trước khi đưa vào code.

export const TEMPLATE_PLACES: PlaceEntry[] = [
  // { name: '다낭', provinceSlug: 'da_nang', cadence: 'core' },
];

export const templateProfile: ProfileSpec = {
  id: 'template',
  places: TEMPLATE_PLACES,
  cadence: {
    core: { cadenceDays: 6, windowDays: 12 },
    mid: { cadenceDays: 12, windowDays: 18 },
    long: { cadenceDays: 21, windowDays: 28 },
  },
  intentGroups: [
    // ['후기', '다녀왔어요', '가성비'],
  ],
  intentLiteral: null,
  commercialNegatives: [],
  placesPerQuery: 3,
  sites: ['facebook.com'],
};
