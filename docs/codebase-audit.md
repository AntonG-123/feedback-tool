# Codebase audit

## Supplied codebase

The specification refers to an existing "AGM codebase", "supplied components" and an "existing proxy worker". **No code was supplied**: the session workspace (`/home/user`) was empty and no repository was attached (the two GitHub repositories visible to the session, `Visiotrade/visiotrade-shop` and `GFT-Studio/gft-baustellen`, belong to other projects and were not used).

Therefore there was nothing to reuse, and the application was built from scratch. If an existing proxy worker or component library exists elsewhere, share it and it can be compared against `server/proxy/` and `web/src/components/`.

## Decisions taken because nothing existed

| Area | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22, ESM | one language for proxy, API, workers; Playwright native |
| API | Express 5 | minimal, async error handling built in |
| DB | PostgreSQL via `pg`, plain SQL migrations | spec preference; no ORM engine binaries; `embedded-postgres` for dev/tests only |
| Frontend | React 19 + Vite + TypeScript, hand-written CSS tokens | small dependency set; no UI kit needed for this surface |
| Proxy | own fetch-and-rewrite proxy (undici + parse5) + in-page runtime shim | full control over SSRF, cookies, site auth; see technical-architecture.md |
| Browser automation | Playwright/Chromium (server) | screenshots, snapshot rendering |
| Storage | local disk behind `server/lib/storage.js` | persistent volume on the host; S3 driver can be added behind the same interface |
| LLM | `@anthropic-ai/sdk` (optional) | contextual validation; rules engine is primary/fallback |

Dependencies (production): express, pg, undici, parse5, multer, cookie-parser, nodemailer, playwright, @anthropic-ai/sdk, zod.

## Technical risks identified

1. **Proxy compatibility** — rewriting proxies cannot guarantee every site works (heavy anti-bot, strict frame-busting JS, absolute-URL hard-coding in JS). Mitigations: runtime shim, Navigation API interception, referer/cookie fallback routing, snapshot render mode, clear error states.
2. **Anchoring** — DOM changes between visits. Mitigation: layered locator with scoring and an explicit "needs attention" state.
3. **Screenshots vs. reviewer's state** — screenshots are rendered fresh server-side, so transient state (open menus, typed input) is not captured.
4. **Real-site testing** — the build environment cannot reach the internet; see testing-report.md.
