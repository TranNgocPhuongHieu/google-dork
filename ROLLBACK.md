2026-08-17 — Phase 1
SEARCH_MAX_ATTEMPTS        3 → 2
PROXY_BLOCKED_COOLDOWN_MS  1200000 → 3600000
PROXY_SUCCESS_COOLDOWN_MS  0 → 180000
search_sites   [facebook, instagram, tiktok] → [facebook, tiktok]
schedule       00:00 → 00:00/08:00/16:00
Lý do: block rate 98.58%, giảm tải để đo lại.

2026-08-18 — Phase 2 rollout config
SEARCH_RECOVERY_ROTATING_ROUNDS  0 → 2
SEARCH_QUERY_DELAY_MIN_MS       30000 → 90000
SEARCH_QUERY_DELAY_MAX_MS       60000 → 180000
PROXY_SUCCESS_COOLDOWN_MS       180000 → 600000
GOOGLE_DORK_IMAGE               social-google-dork-playwright:latest → social-google-dork-playwright:phase2-20260818
DEFAULT_DAILY_PROFILE           vi → vi_legacy (one line; disables the EN companion trigger)
scheduled payloads              vi + en/facebook → vi_legacy only
vi profile sites                [facebook, tiktok] → [facebook, instagram, tiktok]
Lý do: tận dụng rotating proxy có reset_url, giảm burst và kéo dài cooldown sau success.

2026-08-18 — VI Instagram re-enable
Rollback `src/profiles/vi.ts` sites to `['facebook.com', 'tiktok.com']` if the
Instagram worker backlog causes unacceptable discovery-to-content latency.

2026-08-18 — Profile batch (pending deployment)
baseline source commit       7564411a8b96303fdc53b0afdd5c976e88ccfe8e
VI_PLACES                    landmark table → supplied 278-entry table (A=216/B=46/C=16)
vi placesPerQuery             3 → 3 (unchanged)
EN intent groups              merged group → three groups
EN placesPerQuery             3 → 3 (unchanged)
pageDepth                    absent → A=(5,3,2), B=(2,2,1), C=(1,1,1)
legacy page caps              unchanged env tier caps A/B/C=(9,6,3)
Rollback: restore the pre-batch profile files from the baseline source state and
use `search_profile=vi_legacy`; do not remove `vi_legacy` from the registry.

2026-08-18 — Deployed after verification
image                         social-google-dork-playwright:phase2-admin278-20260818
digest                        sha256:31d36473a117c76917237ae294857425b5ce3e13ce84e005ca24a54007a36637
recreate                      2026-08-18T14:41:08+07
smoke                         phase2-admin278-smoke-20260818-1442, terminal DONE at 14:49:29+07
smoke result                  3 CAPTCHA failures, 0 URLs; pipeline/config path reached terminal
