# Social Google Dork Discovery

Google Dork Discovery là daemon Kafka-driven tìm URL bài viết du lịch công khai qua Google. Dịch vụ nhận trigger từ Airflow, dựng query theo profile, chạy Playwright qua proxy pool, lọc URL và đưa URL hợp lệ vào queue Social.

Phạm vi hiện tại:

- Nguồn discovery: Google Search.
- Nền tảng: `facebook.com`, `instagram.com`, `tiktok.com`.
- Profile: `vi_legacy`, `vi`, `en`.
- Database và schema giữ nguyên; crawler không tự gán lại tỉnh sau khi insert.
- CAPTCHA là failure runtime của proxy/search path, không phải một profile ngôn ngữ.

## 1. Kiến trúc profile

Mỗi profile mô tả từ vựng, địa điểm, cadence, site và page depth. Browser locale, `hl`, `gl`, proxy, timeout và transport nằm ngoài profile.

```text
src/profiles/types.ts       kiểu chung và cadence
src/profiles/index.ts       registry + SearchProfile suy ra từ registry key
src/profiles/vi_legacy.ts   đường rollback, đọc entity_registry cũ
src/profiles/vi.ts          bảng địa điểm hành chính VI
src/profiles/en.ts          bảng landmark EN
src/profiles/_template.ts   khung cho ngôn ngữ mới
```

Nguyên tắc mở rộng là “thêm ngôn ngữ = một file mới + một dòng trong `src/profiles/index.ts`”. `SearchProfile` là `keyof typeof PROFILES`; thêm hoặc xoá key sẽ được TypeScript kiểm tra tại mọi caller.

`vi_legacy` dùng `entity_registry.ts` và giữ nguyên query cũ để rollback tức thì. Profile place-based dùng bảng riêng, không sửa registry cũ và không sửa `google_crawler.ts`.

Backfill EN one-shot chạy tay qua `src/serper_en_backfill.ts`; script không được đăng ký vào DAG, scheduler hoặc service production.

## 2. Bảng địa điểm

### VI — 278 entry

| Tier | Quy tắc | Entry |
|---|---|---:|
| A | Tên tỉnh + địa bàn hành chính/điểm trung tâm chi tiết | 216 |
| B | Tên tỉnh sau sáp nhập + 1-2 điểm chính | 46 |
| C | Chỉ tên tỉnh và tỉnh cũ đã gộp | 16 |
| **Tổng** | 34 province slug | **278** |

VI dùng `placesPerQuery=3`, cadence `core/mid/long = 4/8/14` ngày. Tên địa điểm luôn mang `provinceSlug`; `fact_post.keyword_id` vẫn ở cấp tỉnh nên không được tự re-attribution.

### EN — 304 landmark

EN giữ trục landmark mà khách quốc tế thực sự viết, không phải bản dịch bảng VI. Phân bổ theo tier metadata là `A=186`, `B=87`, `C=31`; profile chạy Facebook và có ba nhóm intent hoàn chỉnh.

## 3. Scheduler

Scheduler chạy theo thứ tự chunk-first:

1. `chunkPlaces()` gom địa điểm cùng `provinceSlug` và cùng cadence, tối đa `placesPerQuery`.
2. `selectDuePlaces()` chọn toàn bộ chunk đến hạn; không tách một chunk sau khi đã chọn.
3. `windowFor()` tạo cửa sổ riêng theo cadence của chunk.

Stable hash dùng khóa `provinceSlug|cadence|index`, vì vậy các địa điểm trong cùng chunk giữ cùng nhịp qua các ngày. Cửa sổ rộng hơn cadence để chồng lấn và bù độ trễ index Google.

| Profile | Core | Mid | Long | Window tương ứng |
|---|---:|---:|---:|---|
| `vi` | 4 ngày | 8 ngày | 14 ngày | 8 / 12 / 18 ngày |
| `en` | 6 ngày | 12 ngày | 21 ngày | 12 / 18 / 28 ngày |

`vi_legacy` không đi qua scheduler place-based; nó giữ cửa sổ và alias registry của luồng cũ.

## 4. Page depth

Profile place-based giới hạn số page theo tier và cadence. Giá trị này có thể đổi trong profile mà không sửa logic scheduler/crawler.

| Tier | Core | Mid | Long |
|---|---:|---:|---:|
| A | 5 | 3 | 2 |
| B | 2 | 2 | 1 |
| C | 1 | 1 | 1 |

Giới hạn cuối cùng vẫn bị chặn bởi `max_pages` của payload và `SEARCH_MAX_PAGES`. `vi_legacy` dùng env tier caps cũ: A/B/C `9/6/3`.

## 5. Tải hiện hành

Số liệu cadence-weighted hiện hành, không phải số query của một ngày cụ thể:

| Profile/site | Chunks | Intent/query | Query/ngày |
|---|---:|---:|---:|
| `vi` / Facebook | 117 | 1 | 16.5357 |
| `vi` / Instagram | 117 | 1 | 16.5357 |
| `vi` / TikTok | 117 | 1 | 16.5357 |
| **VI tổng** | — | — | **49.6071** |
| `en` / Facebook | 136 | 3 | 37.9286 |
| **Tổng place profiles** | — | — | **87.5357** |

Phân bổ theo tier/cadence (VI là giá trị mỗi site; nhân ba cho tổng ba site):

| Profile | Tier | Cadence | Places | Chunks | Query/ngày |
|---|---|---|---:|---:|---:|
| `vi` | A | core | 31 | 13 | 3.2500 |
| `vi` | A | mid | 56 | 25 | 3.1250 |
| `vi` | A | long | 129 | 46 | 3.2857 |
| `vi` | B | core | 26 | 13 | 3.2500 |
| `vi` | B | mid | 20 | 11 | 1.3750 |
| `vi` | C | core | 16 | 9 | 2.2500 |
| `en` | A | core | 51 | 22 | 11.0000 |
| `en` | A | mid | 82 | 31 | 7.7500 |
| `en` | A | long | 53 | 22 | 3.1429 |
| `en` | B | core | 15 | 13 | 6.5000 |
| `en` | B | mid | 43 | 16 | 4.0000 |
| `en` | B | long | 29 | 14 | 2.0000 |
| `en` | C | mid | 12 | 9 | 2.2500 |
| `en` | C | long | 19 | 9 | 1.2857 |

Budget invariants của place profiles:

- VI Facebook tối đa 29 từ.
- VI Instagram và TikTok tối đa 30 từ.
- EN Facebook tối đa 32 từ.
- Production có `0` chunk split-intent và `0` literal drop. Fallback tổng quát chỉ hạ địa điểm từ 3 xuống 2 khi bảng tương lai dài hơn budget.

## 6. Payload contract

Payload tối thiểu gồm:

```json
{
  "job_id": "uuid-or-stable-id",
  "job_type": "daily|backfill|manual|reconciliation",
  "search_sites": ["facebook.com"],
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "search_profile": "vi_legacy"
}
```

`search_profile` được validate từ registry bằng `isSearchProfile()`. Field vắng, `null` hoặc rỗng mặc định thành `vi_legacy`; parser luôn trả field này để downstream không phải xử lý `undefined`. `time_filter`, `keyword_ids`, `split_days` và `max_pages` là optional.

Airflow scheduled run phát profile `vi` với ba site và companion `en` trên Facebook. Rollback profile chỉ cần xoá field `search_profile`; parser tự quay về `vi_legacy`. Chi tiết giá trị cũ và mapping rollback nằm trong [ROLLBACK.md](ROLLBACK.md).

## 7. Vận hành

### DAG và Kafka

`social_daily_crawl` chạy lúc `00:00`, `08:00`, `16:00` theo `Asia/Ho_Chi_Minh`, `catchup=False`, `max_active_runs=1`. Scheduled keyword IDs được chia đều vào ba slot; Kafka topic là `social.dork.trigger` và consumer group là `google-dork-playwright-v1`.

Không tăng lịch hoặc recreate giữa job. Trước recreate phải drain-gated:

1. Log có event terminal `DONE`.
2. `fact_crawl_run` không còn `status='running'`.
3. Kafka consumer lag bằng `0`.

Sau đó mới recreate container và ghi image digest/mốc thời gian.

### Đọc kết quả

- `total_urls_discovered`: số URL discovery được crawler trả về trong run; không đồng nghĩa đã scrape content.
- `total_urls_scraped`: số URL downstream đã xử lý trong crawl run.
- `kind=captcha`: Google/proxy block; retry có thể làm tăng cooldown nhưng không tạo content.
- `kind=network`: transport/proxy failure.
- `kind=parse`: parser failure; transport không được đổi trong kiến trúc profile.
- `high_fail_rate`: run bị đánh dấu rủi ro khi failed/blocked vượt threshold.

Smoke run chỉ xác nhận đường ống/config tới terminal; `DONE` với CAPTCHA failure vẫn là thất bại discovery và phải báo riêng.

Các kiểm tra code chính:

```bash
npx tsc --noEmit --project tsconfig.json
npm run lint
```

Test đầy đủ được compile vào thư mục tạm rồi chạy Node test runner. Không dùng `npm test` vì script đó rebuild `dist/`.

## 8. Rollback và an toàn

- Giữ `vi_legacy` trong registry để rollback không cần sửa transport.
- Không sửa `google_crawler.ts`, `entity_registry.ts`, `db.ts` hoặc schema database khi thêm profile.
- Tắt trigger Airflow trước khi xoá một profile khỏi registry; Kafka consumer là at-most-once và không có DLQ cho payload bị reject.
- Thứ tự triển khai là service/image trước, Airflow payload sau.
- Giá trị rollback, image và mốc recreate được ghi trong [ROLLBACK.md](ROLLBACK.md).
- Kế hoạch bật local audio CAPTCHA theo gate G0-G6 nằm trong [GOOGLE_DORK_PRODUCTION_RECOVERY_PLAN.md](GOOGLE_DORK_PRODUCTION_RECOVERY_PLAN.md).

## 9. Known issues

- `vi_legacy` có query Instagram/TikTok lịch sử dài 33-34 từ; Google có thể cắt toán tử ngày. Không sửa vì byte-identical legacy là invariant rollback.
- Instagram worker/backlog nằm ngoài repo này; discovery URL mới có thể chờ lâu trước khi có content.
- CAPTCHA phụ thuộc trạng thái IP/proxy pool. Khi Google block hàng loạt, giảm tải không thay thế được solver hoặc nguồn proxy sạch.
- `fact_crawl_run` là bằng chứng run-level; cần đọc cùng log terminal, Kafka lag và queue downstream, không kết luận từ một health signal.

## 10. Tham chiếu dữ liệu profile

Khi sửa bảng địa điểm, phải giữ các invariant sau:

| Profile | Tổng entry | Tier A | Tier B | Tier C | places/query |
|---|---:|---:|---:|---:|---:|
| `vi` | 278 | 216 | 46 | 16 | 3 |
| `en` | 304 | 186 | 87 | 31 | 3 |

Mọi entry phải trỏ tới `provinceSlug` tồn tại trong registry. Sau khi sửa phải chạy token invariant cho mọi profile/site, kiểm tra không mất intent/literal, kiểm tra legacy byte-identical và cập nhật bảng tải trong README này.
