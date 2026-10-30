# Technical architecture

## 1. System overview

```
 Browser (owner / guest)                         Server (one image, two roles)
┌───────────────────────────────┐   /api/*    ┌─────────────────────────────────────┐
│ App origin  (React SPA)       │────────────▶│ APP  (SERVICE_MODE=app)             │
│  workspace, pins, composer    │             │  REST API, auth, share links        │
│  ▲ postMessage (origin-checked)│            │  validation service, uploads        │
│  │                            │             │  job runner: screenshots, discovery │
│ ┌┴──────────────────────────┐ │             │  notification digests               │
│ │ iframe: PROXY origin       │ │ /p/<tok>/…  ├─────────────────────────────────────┤
│ │  proxied website           │◀┼────────────│ PROXY (SERVICE_MODE=proxy)          │
│ │  + shim.js + overlay.js    │ │            │  signed-token check, SSRF guard     │
│ └────────────────────────────┘ │            │  upstream fetch, HTML/CSS rewrite   │
└───────────────────────────────┘             │  site auth (Webflow/Shopify/basic)  │
                                               │  WebSocket tunnel, snapshot render  │
                                               └──────────────┬──────────────────────┘
                                   PostgreSQL ◀───────────────┤──────▶ file storage (volume)
                                                              └──────▶ headless Chromium
```

The app and the proxy **must** run on different origins: proxied site JavaScript runs on the proxy origin and therefore can never read app cookies, storage or call the API with the owner's session. All privileged actions happen in the app frame; the iframe only reports element selections and positions via `postMessage` (both sides check `event.origin` and `event.source`). The iframe is sandboxed without `allow-top-navigation` (no frame-busting).

`SERVICE_MODE=all` runs both listeners in one process (local development, tests).

## 2. Proxy architecture (`server/proxy/`)

Request: `GET {PROXY_ORIGIN}/p/<token>/<scheme>/<host>/<path>?<query>`

1. **Token** — `projectId.expiry.HMAC` (`lib/crypto.js`), issued by the app to the owner or a valid share-link holder (12 h). The proxy is stateless regarding permissions.
2. **SSRF guard** (`lib/ssrf.js`) — http/https only, ports 80/443/8080/8443, no credentials in URLs, no internal hostnames; DNS answers must all be public (IPv4/IPv6 private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped and NAT64 ranges blocked). The validated address is used for the socket (custom `lookup` on the undici Agent) → no DNS-rebinding window. Redirects are never followed server-side; `Location` is rewritten into the proxy so each hop is re-validated.
3. **Upstream request** — forwards safe headers, translates `Referer`/`Origin` back to the original site, sends per-site cookies (stored on the proxy origin under a `h_<site>__` prefix) and site-auth cookies.
4. **Response** — drops CSP, X-Frame-Options, COOP/COEP/CORP, HSTS, `Link`, etc.; rewrites `Set-Cookie` (namespaced, `SameSite=None; Secure; Partitioned`) and `Location`.
   - **HTML** (`rewrite.js`, parse5): every URL attribute (`href, src, srcset, action, poster, data-src, data-srcset, component-url…`), inline `style`, `<style>`, import maps and inline module imports are mapped into `/p/<token>/…`; CSP/referrer meta tags and SRI attributes removed; tracking/ads/chat/consent scripts removed (`blocklist.js`); consent/chat containers hidden via CSS; third-party iframes (YouTube, maps) left on their origin; then inject `<base>`, `window.__AGM__`, `shim.js` (first) and `overlay.js` (last).
   - **CSS**: `url()` and `@import` rewritten.
   - Everything else is streamed unchanged (range requests supported).
5. **Runtime shim** (`client/shim.js`, runs before site scripts): restores the original pathname via `history.replaceState` so client routers (Next.js, Astro, Framer, Shopify) see the real path; patches `fetch`, XHR, `sendBeacon`, `WebSocket`, `EventSource`, `Worker`, `window.open`, URL properties/`setAttribute`, a MutationObserver for injected markup; intercepts navigations via the Navigation API and link clicks (internal → stays proxied, external → new tab via the app, `#hash` → in-page); disables service workers; blocks non-search form submissions.
6. **Fallback routing** — requests without the prefix (missed root-relative URLs) are recovered from the `Referer` or the partitioned `agm_ctx` cookie; document navigations without any context ask the app to re-navigate (`agm:lost`).
7. **Site authentication** (`siteauth.js`) — Webflow (`POST /.wf_auth`), Shopify (`POST /password`), HTTP Basic. Password stored AES-256-GCM encrypted, login performed server-side, resulting cookies stored encrypted; a password page seen again triggers one re-login; failures produce `auth_required` / `auth_failed`.
8. **Snapshot mode** (per project) — the page is rendered in headless Chromium *through the proxy* (same token; a signed header prevents recursion), its DOM serialised, scripts stripped. For sites whose JS cannot run in the live proxy.
9. **Errors** — invalid URL, blocked URL, DNS failure / unavailable, timeout, auth required/failed, render failure, expired session: an error page that also posts `agm:error` to the app, which shows a dedicated state with "Try again" (and "Add site password" for owners). A 45 s client-side timeout prevents endless loading.

## 3. Database

See `database-schema.md`. PostgreSQL, SQL migrations in `server/db/migrations`, applied at start-up.

## 4. Comment anchoring

See `comment-anchoring.md`. Locator captured in the page; resolution by candidate scoring in the page (viewer) and in the screenshot renderer.

## 5. Screenshot pipeline (`server/screenshots/`)

On comment creation two `screenshots` rows (`full`, `crop`) are created as `pending` and a `screenshot` job is queued (Postgres queue, `FOR UPDATE SKIP LOCKED`, 3 attempts with back-off).
Worker: new Chromium context at the comment's viewport → load the page through the internal proxy URL → auto-scroll (lazy content) → resolve the anchor with the same overlay code → convert drawings from element-relative to document coordinates → inject an SVG layer with drawings + numbered pin (burned into the image) → `fullPage` JPEG (height capped at 12 000 px) and a crop around element ∪ drawings (+160 px context, min 720×420) → files to storage, metadata (size, viewport, page URL) to DB. Final failure marks the rows `failed` (UI offers "Retry"). Every request from the server-side browser is SSRF-guarded (only the internal proxy origin and public hosts).

## 6. Validation architecture

`shared/validation.js` — deterministic intent/slot engine shared by browser (instant) and server (authoritative). Categories: image, text/copy, colour, typography, size, spacing, position, layout, link, functional, add, remove, dislike, general, approval, question, unclear. Each category has required slots (e.g. colour → target value; image replacement → new image attached or described; move → destination; functional → symptom + expected behaviour). Returns `{actionable, canSubmit, category, missing[], questions[], requiredAttachments[], provider}`.

`server/validation/index.js` — provider abstraction. `rules` (default) or `anthropic` (Claude via the official SDK, structured JSON output validated with zod; only comment text, attachment counts and element tag are sent). On provider error/timeout the rules result is returned with `fallback: true` — never an unverified success. The server re-validates on submit and edit (HTTP 422 with questions). The UI enables "Submit comment" only when the server has validated *exactly* the current text + attachments.

## 7. Authentication & sharing

- Owners: email magic link (32-byte token, SHA-256 stored, 20 min, single use, 5 per 15 min per email) → 30-day session cookie (HttpOnly, SameSite=Lax, Secure on https).
- Guests: name → `guests` row + random secret (hash stored); the browser keeps `guestId.secret` in localStorage and sends it as `X-Guest-Token`. Ownership checks (edit/delete) are done server-side against this identity.
- Share links: 24-byte random token, enable/disable, regenerate (old token revoked), optional expiry; revoked/expired links return 410.
- Permissions: owner — everything; guest with link — view, comment, reply, resolve/reopen, edit/delete own comments.

## 8. Background jobs

`screenshot` (concurrency 2), `discover` (sitemap + crawl), notification digest loop (checks every minute; sends when the oldest pending item is ≥10 min old and no digest was sent to that owner in the last hour).

## 9. Deployment requirements

- One Docker image (`Dockerfile`, Playwright 1.63 base with Chromium), two services: `app` (SERVICE_MODE=app, volume at `/data`) and `proxy` (SERVICE_MODE=proxy), each on its own public domain; shared `APP_SECRET` and `DATABASE_URL`; app reaches the proxy internally via `PROXY_INTERNAL_ORIGIN`.
- PostgreSQL 14+ with `pgcrypto`.
- Email: Resend API key or SMTP URL (otherwise links/digests only go to the log).
- ~1 GB RAM per service for Chromium.
- See `../README.md` for the environment variable list.
