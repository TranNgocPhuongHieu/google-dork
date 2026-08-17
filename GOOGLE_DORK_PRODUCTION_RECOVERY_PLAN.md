# Google Dork Production Recovery Plan

## 0. Thông tin kế hoạch

- Cập nhật: `2026-08-04` (`Asia/Ho_Chi_Minh`).
- Phạm vi chính: `Social/google-dork`.
- Mục tiêu cuối: Google Dork chạy production ổn định với local audio reCAPTCHA solver miễn phí, không phụ thuộc API nhận dạng giọng nói bên ngoài.
- Trạng thái tài liệu: sẵn sàng dùng làm checklist chạy goal; không được bỏ qua các gate `G0-G8`.
- Thay đổi production, restart, Airflow pause/resume và production write chỉ thực hiện khi có phê duyệt rõ ràng tại gate tương ứng.

## 1. Terminal outcome của goal

Goal chỉ được đánh dấu hoàn tất khi đồng thời đạt các điều kiện sau:

1. Code, test, Docker image và tài liệu cấu hình đã được cập nhật đồng bộ.
2. Local audio solver đã qua unit, integration, container, failure-injection, shutdown và zombie-process test.
3. Shadow canary dùng `accuracy_probe.ts` đã chạy qua proxy thật nhưng không ghi Social DB và không phát Kafka event.
4. Candidate image đã được deploy production sau approval, không deploy thẳng từ source chưa kiểm thử.
5. Production container chạy đúng candidate image, `init=true`, non-root, model đã load và không có restart loop.
6. Feature được bật theo staged rollout; có circuit breaker để local solver lỗi không làm chết crawler.
7. Có ít nhất một production job hoàn tất sau rollout, hoặc báo rõ local solver chưa gặp CAPTCHA trong production nhưng đã đạt shadow-canary gate.
8. Không có orphan `ffmpeg`, Vosk worker, Chromium context hoặc temp audio file.
9. Không thay Kafka topic, payload, consumer group, Airflow trigger payload hoặc database schema.
10. Có báo cáo cuối tại `Social/google-dork/GOOGLE_DORK_PRODUCTION_ROLLOUT_REPORT.md` với evidence đã redaction.

## 2. Baseline đã xác nhận trước khi lập plan

### 2.1 Runtime và source hiện tại

- Target không phải Git repository; rollback/diff phải dựa vào file hash, snapshot và image digest.
- Container production hiện tại là `google_dork`, image `social-google-dork-playwright:latest`, `init=true`, `restart=always`, chạy non-root `pwuser`.
- Build stage hiện dùng Node 22; runtime Playwright image hiện chạy Node 24. Native/FFI dependency phải được test trong final image, không chỉ trên host/build stage.
- Playwright được pin `1.61.1`; TypeScript strict, CommonJS, output `dist/`.
- `ffmpeg` chưa có trong host và container hiện tại.
- `accuracy_probe.ts` tái sử dụng query/proxy/browser/parser production nhưng không gọi `insertPosts()`.

### 2.2 CAPTCHA hiện tại

- `src/captcha_solver.ts` chỉ hỗ trợ paid 2Captcha.
- `src/google_crawler.ts::solveCaptchaOnPage()` trả `false` ngay nếu 2Captcha không có API key; local solver hiện chưa có integration point độc lập.
- Browser context đang abort toàn bộ `image`, `font`, `media`; reCAPTCHA audio vì vậy sẽ bị chặn nếu không có allowlist hẹp.
- Fixed proxy policy hiện đổi proxy ở CAPTCHA đầu tiên và chỉ cho solver chạy từ CAPTCHA tiếp theo.
- Browser launch hiện chỉ có `--disable-blink-features=AutomationControlled`.
- Chẩn đoán trước đây cho thấy proxy Google có thể timeout ở HTTP/2/QUIC; khi tắt HTTP/2 và QUIC thì Google trả HTTP 200 nhanh rồi chuyển sang CAPTCHA. Kết quả này phải được revalidate ở `G0`, không được xem là bằng chứng production vĩnh viễn.

### 2.3 Lifecycle và rollout risk hiện tại

- Mỗi `BrowserContext` được đóng trong `finally`; Chromium singleton được đóng bởi `closeGoogleCrawler()`.
- `SIGTERM`/`SIGINT` đóng Kafka, producer, Chromium và PostgreSQL; Compose có `stop_grace_period=30s`.
- Kafka consumer commit valid offset trước khi bắt đầu crawl. Restart giữa job có thể làm mất phần workload chưa chạy và Kafka không tự replay.
- Weekly reconciliation có thể tạo container one-shot bằng `docker compose run`; drain chỉ kiểm tra daemon là chưa đủ.
- Proxy pool được giữ in-memory; thay đổi proxy DB không tự refresh trong process hiện tại.

## 3. Quyết định kiến trúc cố định

### 3.1 Chọn giải pháp

- Dùng `JacobLinCool/recaptcha-solver` tag `v0.3.0` (commit `2240022e640b27167c565db5771c9deb6103f3a5`) làm tài liệu tham khảo thuật toán, không cài package đó trực tiếp.
- Port tối thiểu browser/audio flow vào code nội bộ vì upstream có selector `:visible`, `spawnSync(ffmpeg)`, cleanup yếu, model download lúc postinstall và test gần như không có.
- Dùng chính Playwright `Page`/`BrowserContext` đang crawl để giữ nguyên proxy, cookie, user-agent và `data-s`; không mở browser thứ hai.
- Backend đầu tiên là local Vosk qua direct `koffi` FFI và `libvosk` đã checksum; không dùng LLM API hoặc speech API.
- Nếu technical/language gate chứng minh Vosk không đạt, dừng trước production và chuyển riêng backend transcription sang local Whisper. Browser flow và interface không đổi.
- 2Captcha được giữ làm optional paid fallback; không gọi trong canary miễn phí và không bắt buộc có API key.

### 3.2 Luồng xử lý mục tiêu

```text
Google navigation
  -> hard block / "Try again later"?
       -> proxy_blocked, không cố giải audio
  -> CAPTCHA đầu tiên trên fixed path?
       -> giữ policy hiện tại: đổi proxy
  -> CAPTCHA tiếp theo hoặc rotating recovery
       -> local audio enabled?
            -> mở audio challenge trên Page hiện tại
            -> bắt audio response có allowlist
            -> ffmpeg child: MP3 -> PCM S16LE mono 16 kHz
            -> bounded transcription worker
            -> nhập transcript và verify
            -> solved: tiếp tục SERP
            -> fail: paid fallback nếu có key
       -> local audio disabled?
            -> paid fallback nếu có key
       -> không solver nào thành công
            -> mark proxy blocked, tiếp tục bounded recovery
```

### 3.3 Kết quả typed của local solver

```ts
type LocalCaptchaStatus =
  | 'solved'
  | 'audio_unavailable'
  | 'proxy_blocked'
  | 'transcription_failed'
  | 'timeout';

interface LocalCaptchaResult {
  status: LocalCaptchaStatus;
  attempts: number;
  durationMs: number;
  reasonCode?: string;
}
```

Không trả transcript, audio URL, sitekey, cookie hoặc proxy credential trong result/log.

### 3.4 Ngoài phạm vi goal

- Không thay Playwright bằng CloakBrowser trong lần khôi phục này. Chỉ đánh giá CloakBrowser ở goal riêng nếu protocol fix + proxy policy + local solver vẫn không đạt production block-rate gate.
- Không sửa Kafka offset semantics, topic, payload, consumer group hoặc done contract. Commit-before-crawl vẫn là residual risk; rollout này giảm khả năng crash bằng child isolation và bắt buộc drain khi deploy.
- Không sửa Airflow trigger payload. Chỉ cho phép pass-through runtime feature flag nếu rendered one-shot config bị lệch daemon.
- Không thay database schema, migration, CDC hoặc downstream consumer.
- Không tăng `SEARCH_WORKERS`; transcription concurrency và crawler concurrency vẫn bounded ở một.
- Không thêm external speech/LLM API và không tự phát sinh paid 2Captcha call trong test/canary.

## 4. Contract cấu hình mục tiêu

| Biến | Default | Validation | Mục đích |
| --- | ---: | --- | --- |
| `CAPTCHA_LOCAL_AUDIO_ENABLED` | `false` | boolean | Kill switch chính; code mới phải giữ behavior cũ khi false |
| `CAPTCHA_LOCAL_TIMEOUT_MS` | `60000` | `10000..120000` | Tổng timeout của một local solve, gồm tối đa hai audio attempts |
| `CAPTCHA_LOCAL_MAX_ATTEMPTS` | `2` | `1..2` | Chặn retry loop vô hạn |
| `CAPTCHA_LOCAL_LANGUAGE` | `en-US` | `en-US` hoặc `vi-VN` | Phải khớp model/audio language đã qua gate |
| `CAPTCHA_VOSK_MODEL_PATH` | `/opt/models/vosk` | absolute path | Model read-only được đóng trong image |
| `CAPTCHA_FFMPEG_PATH` | `/usr/bin/ffmpeg` | absolute path | Không tìm executable bằng shell/PATH mơ hồ |
| `CAPTCHA_WORKER_SHUTDOWN_MS` | `3000` | `500..10000` | Grace trước khi force-kill transcription worker |
| `CAPTCHA_API_KEY` | empty | existing | Optional 2Captcha fallback, không đổi contract |
| `CAPTCHA_TIMEOUT_MS` | `120000` | existing | Paid fallback timeout, tách khỏi local timeout |

Hằng số không mở thành env để tránh cấu hình sai:

- Transcription concurrency: `1`.
- Queue chờ tối đa: `1`.
- Audio body tối đa: `2 MiB`.
- Audio duration xử lý tối đa: `30s`.
- Worker restart budget: tối đa `2` lần trong một process trước khi mở circuit.
- Temp directory mode: chỉ runtime user truy cập; cleanup trong `finally`.

`describeConfig()` chỉ log enable/status/path/language/timeout; không log key, transcript hoặc proxy URL.

## 5. Thiết kế module và file thay đổi

### 5.1 File mới

| File | Trách nhiệm |
| --- | --- |
| `src/local_captcha_solver.ts` | Validate byte audio đã capture từ Playwright, ffmpeg, transcription orchestration, typed outcomes, retry/timeout và temp cleanup |
| `src/vosk_transcriber.ts` | Supervisor cho một child worker, queue=1, request ID, timeout/cancel, restart budget, graceful shutdown |
| `src/vosk_worker.ts` | Load model đúng một lần, nhận PCM path qua IPC, Vosk recognition, `finalResult()`, free recognizer/model |
| `tests/local_captcha_solver.test.ts` | DOM/selector/audio/fallback/result contract |
| `tests/vosk_transcriber.test.ts` | IPC, timeout, crash, queue, shutdown và orphan cleanup |
| `tests/vosk_image_smoke.test.ts` | Fixture có checksum, Vosk native/model thật dưới runtime user |
| `tests/vosk_lifecycle.test.ts` | 50 real transcriptions, RSS, graceful shutdown và orphan check |

Nếu Vosk gate thất bại, thêm backend local Whisper phía sau cùng interface; không sửa browser orchestration lần hai.

### 5.2 File hiện có cần sửa

| File | Thay đổi có chủ đích |
| --- | --- |
| `src/config.ts` | Thêm config/validation local audio; tách `localEnabled` và `paidEnabled`; mask config output |
| `src/google_crawler.ts` | Tắt HTTP/2/QUIC; media allowlist; local -> paid fallback; hard-block classification; telemetry hook; đóng transcriber trong shutdown |
| `src/captcha_solver.ts` | Giữ paid client; chỉ chuẩn hóa interface/error code nếu cần, không đổi external API |
| `src/proxy_pool.ts` | Chỉ thêm probe filtering/helper nếu cần chọn proxy labels; không thay selection/cooldown production |
| `accuracy_probe.ts` | Aggregate CAPTCHA events, giới hạn query/time/challenge target, in JSON redacted, không ghi DB/Kafka |
| `main.ts` | Shutdown chờ local supervisor dừng; không đổi Kafka payload hoặc consumer group |
| `package.json` | Thêm exact `koffi@2.8.6`; không dùng `vosk-koffi` có downloader postinstall |
| `package-lock.json` | Regenerate bằng package manager hiện tại |
| `Dockerfile` | Pin runtime/build inputs; install ffmpeg; verified Vosk library/model; non-root; no runtime download; smoke check |
| `docker-compose.yml` | Thêm env contract; cho phép candidate image override; giữ `init=true`; feature default false |
| `.env.example` | Mô tả toàn bộ local CAPTCHA variables, không có secret |
| `README.md` | Cập nhật architecture/config/runbook/risks/evidence sau khi implementation đã đúng |
| `tests/google_crawler.test.ts` | Browser args, route allowlist, hard block, fallback order, disabled-mode regression |
| `tests/payload_config.test.ts` | Default/bounds/invalid values và masked config |

### 5.3 Supply-chain policy bắt buộc

`vosk-koffi@1.1.1` có postinstall tải `libvosk 0.3.45` từ GitHub và không kiểm SHA256. Postinstall còn có thể chỉ log download failure, khiến dependency install trông như thành công dù thiếu native library. Nó chỉ là tài liệu tham khảo, không được cài trong production image; implementation dùng `koffi@2.8.6` với `libvosk` do Docker stage kiểm SHA256.

Implementation phải:

1. Chạy dependency install với scripts bị tắt hoặc chặn riêng postinstall không kiểm chứng.
2. Download exact `libvosk` archive/version trong dedicated build stage.
3. Verify hard-coded SHA256 trước khi extract/copy.
4. Download exact Vosk model archive và verify hard-coded SHA256.
5. Không download model/library lúc container start.
6. Ghi license/attribution cho upstream solver reference, `koffi`, Vosk model/library và ffmpeg package.
7. Pin base image bằng version và record digest trong rollout report; nếu thay digest phải chạy lại full image gate.

## 6. Lifecycle, backpressure và chống zombie

### 6.1 Transcription supervisor

- Chỉ một Vosk worker tồn tại cho mỗi crawler process.
- Model load một lần trong worker; log duy nhất `captcha_model_loaded` không chứa path nhạy cảm.
- Parent gửi `{requestId, pcmPath}` qua IPC; worker trả `{requestId, ok, text}` hoặc stable error code.
- Request thứ hai được queue; request thứ ba nhận `busy`/`transcription_failed`, không tăng queue.
- Native crash chỉ làm chết child; parent restart bounded, không làm chết KafkaJS/main process.
- Quá restart budget thì circuit mở, local solver bị bypass và crawler dùng paid/proxy recovery.

### 6.2 ffmpeg và temp files

- Dùng `spawn()` với argv cố định và `shell=false`; không dùng `spawnSync`, `exec` hoặc nội suy shell.
- Track toàn bộ active child processes trong `Set`.
- Mỗi attempt dùng `mkdtemp`; source/output path do code tạo, không nhận từ payload/network.
- Giới hạn body, duration, timeout và stderr bytes.
- `finally` phải remove response listener, close streams, terminate ffmpeg, remove temp files và release queue slot.
- Shutdown gửi cancel, `SIGTERM`, chờ `CAPTCHA_WORKER_SHUTDOWN_MS`, sau đó `SIGKILL` nếu child chưa thoát.
- `closeGoogleCrawler()` idempotent và đóng solver supervisor trước/đồng thời với browser theo thứ tự không để request mới phát sinh.

### 6.3 Circuit breaker

- Mở circuit khi worker crash/restart budget vượt ngưỡng hoặc lỗi nội bộ liên tiếp đạt ngưỡng đã test.
- `audio_unavailable` và `proxy_blocked` không được tính là native worker crash.
- Circuit mở không crash query; trả stable failure để paid fallback hoặc proxy recovery tiếp tục.
- Circuit state chỉ in-memory và reset khi process restart; log transition một lần, tránh spam.

## 7. DOM, network và verification rules

### 7.1 Selector

- Không dùng Playwright pseudo selector `:visible` gắn trực tiếp vào iframe selector.
- Hỗ trợ `api2` và `enterprise`, Google host và `recaptcha.net` nếu thực tế xuất hiện.
- Tìm attached frames theo URL/path, sau đó xác nhận frame có challenge/audio controls.
- Hỗ trợ checkbox challenge và challenge frame đã mở sẵn.
- Selector drift trả `audio_unavailable` hoặc stable selector error; không giả báo solved.

### 7.2 Media allowlist

- Tiếp tục block image/font/media không cần thiết.
- Chỉ allow HTTPS response thuộc host suffix hợp lệ và path reCAPTCHA audio/payload đã xác nhận.
- Host check phải chống dạng `google.com.evil.example`.
- Không fetch arbitrary audio URL do DOM cung cấp nếu chưa validate protocol/host/path.
- Không log audio URL/query string vì có thể chứa token tạm.

### 7.3 Xác nhận solved

Không tính solved chỉ vì đã submit transcript. Phải có ít nhất một bằng chứng:

- reCAPTCHA verification response báo pass; và
- checkbox/challenge state chuyển solved; hoặc
- trang rời `/sorry/` và SERP selector xuất hiện.

Nếu vẫn ở CAPTCHA, kết quả là failure dù transcript có vẻ hợp lệ.

## 8. Goal execution plan và gates

### G0 - Freeze baseline và technical gate

Checklist:

- [ ] Tạo manifest SHA256 cho toàn bộ file sẽ sửa vì workspace không có Git.
- [ ] Record current container image ID/digest, start time, restart count và process tree.
- [ ] Record rendered `docker compose config` nhưng redaction mọi credential.
- [ ] Revalidate Google qua 2-3 proxy với Chromium default và với `--disable-http2 --disable-quic`.
- [ ] Không log/reproduce proxy credential hoặc rotating reset URL.
- [ ] Xác định audio challenge language thực tế từ ít nhất 3 challenge samples.
- [ ] Verify direct `koffi` load/model transcription trong final Playwright runtime Node version, không chỉ host Node 22.
- [ ] Verify ffmpeg conversion và Vosk transcription với fixture có provenance/checksum.
- [ ] Verify `npm ci` strategy không chạy unverified postinstall và final image vẫn có đủ native library.

Pass criteria:

- Google navigation không còn timeout hệ thống khi dùng protocol flags trên proxy đạt chuẩn.
- Final image có thể load/unload Vosk model và transcribe fixture đúng normalized expected text.
- Audio language được model hỗ trợ; nếu mixed/unsupported hoặc accuracy không đạt, chuyển backend gate sang local Whisper trước `G1`.
- Không có runtime network download của model/library.

Stop criteria:

- Native library không chạy ổn trên final runtime.
- Không xác định được audio language.
- Proxy không thể tải Google/audio ngay cả sau protocol fix.
- Checksum/license/provenance của binary/model không xác nhận được.

### G1 - Config, browser transport và supply-chain foundation

- [ ] Thêm validated env contract và config description đã mask.
- [ ] Thêm `--disable-http2` và `--disable-quic` vào Chromium args.
- [ ] Viết media allowlist hẹp và unit tests.
- [ ] Pin dependency/library/model/ffmpeg build inputs.
- [ ] Cập nhật Docker build để runtime non-root đọc model, không ghi vào model directory.
- [ ] Feature vẫn `false` ở code, Compose và example.

Gate: build/lint/config tests pass trước khi viết browser audio flow.

### G2 - Bounded transcriber worker

- [ ] Implement `vosk_worker.ts` và `vosk_transcriber.ts`.
- [ ] Model load once, recognizer free every request, model free on shutdown.
- [ ] Implement request timeout, queue=1, crash restart budget và circuit breaker.
- [ ] Implement ffmpeg async child, byte/duration limits và temp cleanup.
- [ ] Test success, empty transcript, malformed response, ffmpeg failure, worker crash, timeout, cancellation và shutdown.

Gate: zero orphan process/temp file trong synthetic lifecycle suite.

### G3 - Browser audio solver và fallback integration

- [ ] Implement robust frame discovery, audio mode, response capture và answer submission.
- [ ] Preserve fixed first-CAPTCHA proxy rotation policy.
- [ ] Hard block đi thẳng `proxy_blocked`.
- [ ] Subsequent CAPTCHA order: local audio -> paid fallback if configured -> block/rotate.
- [ ] Local disabled + paid disabled phải giống behavior cũ.
- [ ] Rotating recovery nhận biết `localEnabled || paidEnabled`, không phụ thuộc riêng API key.
- [ ] Thêm stable telemetry hook cho probe; không đổi Kafka/done payload.

Gate: fallback-order tests và DOM fixture tests pass.

### G4 - Full repository verification

Chạy theo thứ tự:

```bash
npm ci --ignore-scripts
npm run build
npm run lint
npm test
docker compose config
```

Sau đó build candidate bằng immutable tag, không ghi đè `latest`:

```bash
docker build --pull -t social-google-dork-playwright:captcha-audio-<RUN_ID> .
```

Gate:

- Existing tests và tests mới đều pass.
- Final image chạy đúng Node/Playwright version đã record.
- `ffmpeg` executable, model/library readable bởi `pwuser`.
- Image smoke transcribe fixture pass.
- Không có `.env`, proxy catalog, credential hoặc test audio nhạy cảm trong image layer.
- Image-size delta được ghi nhận; delta Vosk path lớn bất thường phải review trước canary.

### G5 - Failure injection, shutdown và soak

Test tối thiểu:

- 50 synthetic transcription requests sau warm-up.
- 10 forced ffmpeg timeouts.
- 10 forced worker crashes.
- Queue overflow và duplicate/late IPC response.
- `SIGTERM` trong lúc download audio, ffmpeg chạy, Vosk chạy và browser navigation.
- Repeated `closeGoogleCrawler()`.

Pass criteria:

- Zero orphan `ffmpeg`, Vosk worker và temp directory sau mỗi test group.
- Shutdown hoàn tất dưới `stop_grace_period=30s`.
- Model load count bằng 1 trong steady-state process.
- End RSS sau warm-up không tăng quá `20%` hoặc `150 MiB` so với warmed baseline, lấy ngưỡng lớn hơn; không có xu hướng tăng đơn điệu theo request.
- Main/Kafka event loop không bị block bởi CPU/native transcription.
- Circuit breaker mở đúng và crawler vẫn tiếp tục fallback.

### G6 - Shadow canary, không DB/Kafka write

Candidate chạy bằng `accuracy_probe.ts`, không chạy `main.ts`:

- `KAFKA_ENABLED=false`.
- `CAPTCHA_API_KEY` phải empty để chứng minh local-free path.
- `CAPTCHA_LOCAL_AUDIO_ENABLED=true`.
- Probe fail trước khi import crawler nếu thiếu `PROBE_CONFIRM_LIVE=true` hoặc local audio không bật.
- Một page/query worker.
- Tối thiểu 20 challenge audio được offer trên ít nhất 3 proxy labels.
- Bound canary: tối đa 100 queries hoặc 2 giờ; chạm bound mà chưa đủ 20 challenge thì gate là inconclusive, không tự hạ threshold.
- `PROBE_MAX_DURATION_MS` phải abort query đang chạy, BrowserContext và local worker; kết quả JSON phải ghi `stop_reason=time_limit`, không phụ thuộc operator `docker stop`.
- `PROBE_TARGET_AUDIO_CHALLENGES` không được nhỏ hơn `20`. Khi cần kiểm tra các proxy chưa được cover, `PROBE_PROXY_LABELS` chỉ nhận `3-20` opaque labels từ catalog; nó tạo pool probe riêng, không sửa catalog hoặc pool production, và từ chối rotating proxy/reset.

Candidate image có thể được chọn qua Compose image override, nhưng không thay production container:

```bash
GOOGLE_DORK_IMAGE=social-google-dork-playwright:captcha-audio-<RUN_ID> \
docker compose run --rm --no-deps --entrypoint node \
  -e KAFKA_ENABLED=false \
  -e CAPTCHA_API_KEY= \
  -e CAPTCHA_LOCAL_AUDIO_ENABLED=true \
  google-dork dist/accuracy_probe.js
```

Acceptance:

- Local solve success `>=60%` khi audio được offer.
- Local solve p95 `<=60s`.
- Zero paid API calls/cost.
- Zero orphan process/temp file.
- Container exit code `0`; no native crash/restart storm.
- Không log transcript, audio URL, sitekey, cookies hoặc proxy credential.
- CAPTCHA page chỉ được tính solved khi đã qua verification rule ở mục 7.3.

### G7 - Production preflight và approval gate

Không được deploy nếu chưa hoàn thành:

- [ ] Gửi candidate image ID/digest, source hash diff, test summary, canary metrics và known risks cho user.
- [ ] Nhận explicit approval deploy production.
- [ ] Xác nhận exact target là container `google_dork` và external network đúng.
- [ ] Tạm dừng nguồn trigger daily/weekly trong maintenance window đã duyệt.
- [ ] Chờ active job kết thúc; không dùng Kafka lag=0 làm bằng chứng duy nhất vì offset commit trước crawl.
- [ ] Xác nhận không có weekly one-shot `docker compose run` đang chạy.
- [ ] Kiểm tra recent logs, process tree và `fact_crawl_run status='running'` bằng read-only query.
- [ ] Record current image thành rollback tag/digest; không xóa image cũ.
- [ ] Xác nhận rendered config cho daemon và Airflow one-shot cùng feature state; nếu khác nhau, thêm explicit env pass-through, không đổi payload Kafka/Airflow.

Nếu không drain được an toàn, dừng goal ở gate này; không restart giữa active job.

### G8 - Staged production rollout

Phase A - Deploy code, feature off:

- Promote candidate thành production tag theo procedure đã duyệt.
- Recreate riêng service `google-dork`, không restart DB/Kafka/Airflow/khác.
- `CAPTCHA_LOCAL_AUDIO_ENABLED=false`.
- Verify startup, Kafka subscription, browser launch flags, image digest, restart count và graceful process tree.
- Quan sát tối thiểu 15 phút hoặc đến readiness evidence đầu tiên.

Phase B - Enable local audio:

- Chỉ bật sau Phase A pass và config source đã nhất quán cho daemon/one-shot.
- Recreate trong drained window; không làm giữa active job.
- Verify startup log cho local solver; model chỉ load khi cần hoặc theo lazy-load contract đã chọn.
- Resume daily/weekly triggers sau khi container sẵn sàng.

Phase C - Production observation:

- Theo dõi ít nhất production job đầu tiên đến terminal state.
- Xác nhận query progress, blocked/failed counts, done publication nếu có, crawl-run terminal và data checkpoint/row evidence phù hợp.
- Nếu gặp CAPTCHA, kiểm tra local outcome/latency/circuit state và orphan process.
- Nếu chưa gặp CAPTCHA, báo rõ solver mới chỉ có shadow-canary evidence; không tuyên bố production solve rate.

Production pass criteria:

- Container restart count không tăng ngoài recreate dự kiến.
- Không có fatal/native crash, unbounded RSS hoặc orphan process.
- Không làm tăng failed/blocked query theo failure threshold đã định ở canary/baseline.
- Một job production hoàn tất hoặc có documented reason vì chưa có scheduled workload trong observation window.
- Feature state đúng cho daemon và weekly one-shot.

## 9. Test matrix bắt buộc

| Nhóm | Cases tối thiểu |
| --- | --- |
| Config | defaults, enable, invalid boolean, timeout bounds, attempts bounds, language enum, masked output |
| Browser flags | HTTP/2/QUIC disabled, existing automation flag retained |
| Route | allow valid reCAPTCHA audio; deny normal media, HTTP, wrong path và deceptive host |
| Frame selectors | api2, enterprise, recaptcha.net, attached-not-visible, challenge already open, missing frame |
| Audio | content-type variants, max bytes, response timeout, duplicate responses, unavailable audio |
| ffmpeg | success, non-zero exit, hang, killed process, missing binary, bounded stderr |
| Vosk | model load once, finalResult, empty/invalid JSON, recognizer free, worker crash |
| Queue | one active, one waiting, third rejected, cancellation releases slot |
| Orchestration | first CAPTCHA rotates; local solved; local fail -> paid; paid disabled; hard block |
| Verification | submitted but still CAPTCHA = fail; leave `/sorry/` + SERP = solved |
| Shutdown | SIGTERM at every phase, repeated close, child kill escalation, under 30s |
| Security | no secret/transcript/audio URL in logs; no shell interpolation; temp permissions |
| Regression | all current parser/query/proxy/logger/payload/2Captcha tests remain green |
| Container | non-root, model read-only, no runtime download, image smoke transcription |
| Live canary | >=20 offered challenges, >=3 proxies, success/latency/zombie/RSS gates |

## 10. Observability contract

Structured event names:

- `captcha_detected`
- `captcha_hard_block`
- `captcha_local_attempt`
- `captcha_local_result`
- `captcha_paid_fallback`
- `captcha_worker_started`
- `captcha_worker_restarted`
- `captcha_worker_stopped`
- `captcha_circuit_open`

Allowed fields:

- `job_id`, query index/site, proxy label, attempt, status, reason code, duration ms, circuit state, worker restart count.

Forbidden fields:

- Raw proxy URL/credential, rotating reset URL, API key, cookie, user-agent if identifying, sitekey, `data-s`, audio URL/query, audio bytes/path, transcript.

Canary/rollout report phải có:

- Offered/attempted/solved counts.
- Outcome distribution.
- p50/p95 duration.
- Distinct proxy-label count.
- Worker restart/circuit counts.
- Process/RSS baseline và end state.
- Container image ID/digest and exact config flags, đã redaction.

## 11. Rollback và recovery

### 11.1 Soft rollback

- Circuit breaker tự bypass local solver khi worker không ổn.
- Nếu crawler còn healthy, giữ process chạy và dùng paid/proxy fallback; tránh restart giữa committed active job.
- Sau khi job kết thúc, set `CAPTCHA_LOCAL_AUDIO_ENABLED=false` và recreate trong drained window.

### 11.2 Image rollback

- Giữ previous production image bằng immutable rollback tag/digest trước deploy.
- Pause trigger, drain daemon và one-shot như `G7`.
- Repoint production tag về previous image và recreate riêng `google-dork`.
- Verify image digest, startup, Kafka subscription và next job.
- Không cần database rollback hoặc Kafka schema rollback vì goal không thay các contract này.

### 11.3 Emergency rollback

Nếu memory/native failure đe dọa host, ưu tiên stop/recreate dù active job có nguy cơ mất phần chưa chạy. Phải record `job_id`, window, site và checkpoint; reconciliation/backfill sau đó là hành động production riêng cần approval.

Không xóa image, model cache, log hoặc temp diện rộng trong goal này. Cleanup material cần inventory và authorization riêng.

## 12. Rủi ro còn lại và cách chặn

| Rủi ro | Control/gate |
| --- | --- |
| Google thay DOM/audio | Selector fixtures + stable failure + paid/proxy fallback |
| CAPTCHA audio khác ngôn ngữ | G0 sample language gate; local Whisper branch nếu Vosk không đạt |
| Vosk native crash | Child isolation, restart budget, circuit breaker |
| ffmpeg hang/zombie | Async spawn, timeout, process tracking, init=true, SIGTERM/SIGKILL test |
| Supply-chain download | Ignore unverified postinstall; pin URL/version/SHA256; no runtime download |
| Model memory growth | Load once, bounded queue, RSS soak gate |
| Proxy bị hard block | Direct `proxy_blocked`, cooldown/rotation; không cố solve vô ích |
| Restart mất Kafka workload | Pause triggers + drain daemon/one-shot before recreate |
| Weekly one-shot config drift | Render config từ Airflow execution context before enabling production |
| 2Captcha data transfer | Optional only; local canary unsets key; no new credential exposure |
| No Git rollback | File hash manifest + immutable image digest + final source snapshot |
| CAPTCHA terms/policy | Operational owner xác nhận quyền sử dụng/rate policy trước production enable |

## 13. Definition of done

- [ ] G0 technical/language/supply-chain gate pass.
- [ ] Local solver chạy trên existing Page/context/proxy.
- [ ] First-CAPTCHA rotation và existing disabled behavior được giữ.
- [ ] Kafka/Airflow payload, consumer group và DB schema không đổi.
- [ ] `npm run build`, `npm run lint`, `npm test` pass thực tế.
- [ ] Candidate Docker build/smoke pass dưới `pwuser`.
- [ ] Failure injection, SIGTERM và zombie tests pass.
- [ ] Shadow canary đạt threshold với paid API disabled.
- [ ] Production approval và drain evidence đã có.
- [ ] Candidate image được deploy theo staged rollout.
- [ ] Production container/image/config/process state đã verify.
- [ ] First production job hoặc documented observation result đã verify.
- [ ] Rollout report đã xuất, không chứa secret.
- [ ] Không còn task bắt buộc chưa hoàn thành.

## 14. Goal runner contract

Objective dùng khi chạy goal:

> Implement, verify and deploy the Google Dork production recovery described in `Social/google-dork/GOOGLE_DORK_PRODUCTION_RECOVERY_PLAN.md`. Execute gates G0 through G8 in order, preserve Kafka/Airflow payloads and database schemas, keep local CAPTCHA disabled until canary passes, never expose credentials, do not deploy or restart production without the G7 approval/drain gate, and finish only after production evidence and `GOOGLE_DORK_PRODUCTION_ROLLOUT_REPORT.md` are complete.

Quy tắc dừng goal:

- Dừng ngay khi phát hiện unexpected overlapping file changes.
- Không xây tiếp trên technical gate thất bại hoặc test failure chưa giải thích.
- Không hạ acceptance threshold để lấy pass.
- Không tự chuyển sang paid API/cost trong canary.
- Không deploy khi active job/one-shot chưa drain.
- Không tuyên bố production success chỉ từ container `Up` hoặc một probe đơn lẻ.
