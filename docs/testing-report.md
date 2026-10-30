# Testing report

Run: 2026-10-30, Node 22.22, Playwright 1.63 (Chromium, headless), 1440×900, embedded PostgreSQL 18.

```
npm run test:unit    # 19 tests  – 19 passed
npx playwright test  # 27 tests  – 27 passed, 0 flaky (86 s)
npm run typecheck    # tsc – 0 errors
```

## What the suites cover

### Unit (`tests/unit/`)
- **Validation engine** — all specification examples word-for-word ("Just adjust it.", "Please replace the image.", "Change the image.", "I would rephrase this."), category questions (bigger/smaller, colour, move, button, link, spacing, font, add, dislike, layout, typo), empty/very short/gibberish input, *padding vague text with extra words keeps it blocked*, attachment awareness (image attached → no more image request; image element + pronoun), 21 specific actionable comments accepted, result structure.
- **Validation provider failure** — LLM provider configured but unreachable → rules fallback (`fallback: true`), vague still blocked, specific still allowed.
- **SSRF** — private/loopback/link-local/CGNAT/multicast/IPv6 ULA/IPv4-mapped/NAT64 addresses; unsafe schemes, credentials, ports, internal names, decimal/hex IP forms. *(Found and fixed a gap: NAT64 hex form `64:ff9b::7f00:1` was accepted.)*
- **Rewriting** — URL mapping (relative, root-relative, absolute, protocol-relative, special schemes, idempotence, third-party iframes), CSS `url()`/`@import`, `srcset`, original `<base>`, CSP meta, SRI, trackers, import maps, Astro islands, injection.
- **Discovery** — sitemap index/urlset/CDATA/entities, link extraction; URL normalisation/de-duplication; sitemap tree categories, sub-categories and aggregated counts.

### End-to-end (`tests/e2e/`, real browser, real server, real DB)
| Spec | Covers |
|---|---|
| `workflow.spec.js` (9) | magic-link login → create project → proxied render (CSS, fonts, JS, fetch, images, scripts removed, cookie banner hidden, sitemap tree) · vague feedback blocked with exact questions, submit disabled, drawing (rectangle + arrow) · comment submitted, pin #1 · full-page + crop screenshot stored, JPEG download, drawings element-relative · pin anchored after reload, scrolling; hidden on mobile, back on desktop · reply, edit (re-validated), resolve → green, hide resolved, reopen, hide all · share link → guest (no account) navigates in-frame, sitemap follows, name prompt, "Change the image." → attach request → upload → submit; guest cannot edit owner comment (403); name remembered · overview filters + jump to pin · disable / regenerate share link · guest may resolve, may not delete others (403), no access without token (401); owner deletes any comment |
| `proxy.spec.js` (8) | SPA routing + pathname + fetch + dynamic import + deep-link reload + comment on client route · Webflow password (none / wrong / correct via settings, secret never returned) · Shopify password · DNS failure on creation, invalid URL, **timeout state**, tampered token · form POST blocked (UI + direct), GET search works · external link in new tab, 301 redirect stays in proxy · SSRF via project creation (8 URLs) and via proxy paths (6) · snapshot mode |
| `anchors.spec.js` (4) | 3 comments incl. 2nd of 3 identical cards · text change + wrapper insertion · removed element → "!" + persisted `needs_attention` → recovery · window resize, tablet-only comment, re-anchoring after reload, viewport stored = 768 |
| `media.spec.js` (5) | voice recording (fake mic) stored as audio, transcript inserted, validated, edited, submitted; original audio downloadable · no speech service → audio kept, user asked to type · mic permission denied message · paste + drag-and-drop images, fake PNG rejected · notification batching: 3 quick comments → 1 digest, next digest only after the interval, owner's own comments not queued |
| `visual.spec.js` (1) | captures 11 screens to `docs/screenshots/` |

### Bugs found by the tests and fixed
- Login race: an in-flight `/auth/me` could overwrite a fresh login (redirect back to login).
- Composer: validation text appearing on blur shifted the toolbar between mousedown and mouseup → toolbar clicks were lost.
- Breakpoint width animation stored a non-final viewport width with comments.
- Notification digest sent the first comment of a burst alone → added settling delay.
- Snapshot mode and screenshot worker: server-side Chromium could request hosts directly → now rendered through the proxy and every request SSRF-guarded.

## Not tested (and why)

| Item | Reason |
|---|---|
| Real Webflow / WordPress / Shopify / Next.js / Astro / Framer sites | build environment has no internet access |
| Visual regression **against MarkUp.io** | reference site blocked (see reference-analysis.md); only implementation screenshots exist |
| Real email delivery (Resend/SMTP) | no credentials; delivery `log` verified |
| LLM validation with a real API key, server-side transcription (OpenAI/Deepgram) | no credentials; failure path tested |
| Real speech recognition | headless Chromium has no speech service; simulated in tests |
| WebSocket tunnel, HTTP Basic site auth | no fixture yet |
| Safari / Firefox | only Chromium installed |
| Touch input on real devices | pointer events used; not tested on hardware |

## Recommended next test run (after deployment)
1. Create projects for one real site per platform (e.g. a Webflow template site, a WordPress blog, a Shopify demo store, nextjs.org, astro.build, a framer.website) and run the workflow manually or adapt `workflow.spec.js` with `baseURL` = deployed app.
2. Record per-site issues in `proxy-compatibility.md`.
