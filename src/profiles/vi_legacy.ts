import { ProfileSpec } from './types';

/** Profile giữ NGUYÊN XI hành vi production hiện tại.
 *  Tồn tại để rollback tức thì và để tests/query_builder.test.ts luôn xanh.
 *  KHÔNG sửa file này khi thêm ngôn ngữ mới. */
export const viLegacyProfile: ProfileSpec = {
  id: 'vi_legacy',
  useLegacyRegistry: true,
  places: [],
  cadence: {
    core: { cadenceDays: 1, windowDays: 1 },
    mid: { cadenceDays: 1, windowDays: 1 },
    long: { cadenceDays: 1, windowDays: 1 },
  },
  intentGroups: null,
  intentLiteral: 'du lịch',
  commercialNegatives: [
    'combo', 'booking', 'hotline', 'liên hệ', 'zalo',
    'sđt', 'inbox', 'ib', 'tour', 'báo giá',
  ],
  placesPerQuery: 4,
  sites: ['facebook.com', 'instagram.com', 'tiktok.com'],
};
