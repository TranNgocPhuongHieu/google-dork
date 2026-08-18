import { ProfileSpec } from './types';
import { viLegacyProfile } from './vi_legacy';
import { viProfile } from './vi';
import { enProfile } from './en';

/** Registry của mọi profile.
 *
 *  THÊM NGÔN NGỮ: tạo <lang>.ts rồi thêm đúng một dòng vào đây.
 *  BỎ NGÔN NGỮ: xoá dòng ở đây — TypeScript sẽ báo lỗi tại MỌI chỗ còn tham chiếu,
 *  nên không thể sót. (Nhớ tắt trigger Airflow TRƯỚC khi xoá code: consumer commit
 *  offset trước khi xử lý và không có DLQ.) */
export const PROFILES = {
  vi_legacy: viLegacyProfile,
  vi: viProfile,
  en: enProfile,
} as const;

/** Type suy ra TỪ registry — không hard-code union. Đây là thứ làm scale an toàn. */
export type SearchProfile = keyof typeof PROFILES;

export const DEFAULT_PROFILE: SearchProfile = 'vi_legacy';

export function isSearchProfile(v: unknown): v is SearchProfile {
  return typeof v === 'string' && Object.hasOwn(PROFILES, v);
}

export function getProfile(id: SearchProfile): ProfileSpec {
  return PROFILES[id];
}

export * from './types';
