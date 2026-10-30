# Known limitations

## Environment-related (this build)

1. **MarkUp.io was not inspected** — the reference site, REA's website and Playwright access to them were blocked by the build environment's network policy. Visual fidelity is an informed reproduction, not a measured one (see reference-analysis.md).
2. **No real websites tested** — all proxy tests use local fixture sites. Webflow/WordPress/Shopify/Next.js/Astro/Framer compatibility on real sites is unverified.
3. **Email** — without `RESEND_API_KEY` or `SMTP_URL`, magic links and digests are only written to the server log. The evaluation deployment shows the login link on screen (`DEV_LOGIN_LINKS=true`), which lets anyone log in as any email address — **never use that setting for real data.**

## Product

- Screenshots are rendered fresh on the server at the comment's viewport; transient UI state (open dropdowns, typed text, hover states, carousels mid-slide) and per-user content are not captured.
- Transcription: without `OPENAI_API_KEY`/`DEEPGRAM_API_KEY` the browser's speech recognition is used (Chrome/Edge; sends audio to the browser vendor's service; unavailable in Firefox). The audio is always stored; when no transcript is available the reviewer is asked to type.
- Validation: the rules engine is English-only. German or other languages are classified as "unclear" unless long and descriptive; configure `ANTHROPIC_API_KEY` for multilingual, contextual validation. Replies are not validated (conversation).
- Real-time: other reviewers' comments appear by polling (10 s, 3 s while screenshots render), not via push.
- Owner display name defaults to the e-mail prefix (no profile screen; API `PATCH /api/auth/me`).
- Single-instance assumptions: in-memory rate limiting and caches; for multiple replicas use a shared store.
- Desktop-only application UI (≥1100 px). Touch input works for pins and drawing (pointer events) but no tablet/phone layout of the app itself exists by design.
- WebSocket proxying and HTTP Basic auth are implemented but untested.
- Storage driver is local disk (needs a persistent volume); an S3 driver is not yet implemented.
