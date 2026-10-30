# Reference analysis — MarkUp.io

## 0. What could and could not be inspected (read first)

| Source | Result |
|---|---|
| `https://www.markup.io/`, `https://app.markup.io/` | **Blocked.** The build environment's network policy denies these hosts (HTTP 403 on CONNECT from the container, DNS failure from the fetch service). |
| `https://rea.tools/` | **Blocked** (same reason). |
| `https://github.com/morluto/rea` (README, `docs/cli.md`) | Readable. REA is an MCP server/CLI (`npx rea-agents …`) that analyses binaries, JS/Electron apps and **websites** (page structure, scripts, network, screenshots) — but it runs *locally* and would need network access to markup.io, which the environment does not have. |
| Third-party pages about MarkUp (G2, SaaSworthy, GetApp, Chrome Web Store, help articles) | Fetch blocked; only **search-result snippets** were available. |
| Playwright against markup.io | Not possible (same network restriction). |

**Consequence:** no screen of MarkUp.io was inspected live, no pixel measurements of the reference were taken, and no visual-regression comparison *against MarkUp.io* could be run. Everything below marked *(public description)* comes from search snippets; everything marked *(assumption)* is our design decision based on general knowledge of the product category. Nothing here claims verified knowledge of MarkUp's internals or proprietary code.

**To complete this phase**, allow `www.markup.io`, `app.markup.io`, `rea.tools` (and optionally `github.com`) in the environment's network settings and re-run: `npx -y rea-agents@latest` website analysis + `tests/e2e/visual.spec.js` against both products at 1440×900.

## 1. Reference UI structure

Publicly described behaviour *(public description)*:
- A "MarkUp" is created from a URL (also PDFs/images/video — out of scope here).
- Reviewers navigate the live website inside MarkUp and add comments on any page.
- Click anywhere to leave a pinned comment; comments are grouped by page in a sidebar; clicking a comment takes you to its page and pin.
- Distinct **Browse** and **Comment** modes (a demo video is titled around "Comment vs Browse").
- Public share links; guests can comment without an account; clients find it easy to use.
- Reported weaknesses: occasional slow loading, limited navigation between pages, occasional comment display issues.

Implemented layout (our reproduction, *assumption* where not described):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Project name / path │ [Browse|Comment] [▭ ▯ ▯] │ 👁 ⤢ Overview ⚙ Share │  56px header
├───────────────┬──────────────────────────────────────────────────────────┤
│ Pages│Comments│  ⟳ [ https://site.com/page                        ] ↗   │  40px address bar
│ 🔍 search     │ ┌──────────────────────────────────────────────────────┐ │
│ ▾ Services  2 │ │  proxied website (iframe, device width)             │ │
│    Web design │ │      ①  pin ─┐                                       │ │
│    SEO        │ │              └─ comment popover (360px)              │ │
│   Blog        │ └──────────────────────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────────────────────┘
  300px sidebar                 canvas (#eef0f3)
```

## 2. Screens and navigation

| Screen | Route | Notes |
|---|---|---|
| Login (magic link) | `/login`, `/auth/verify` | email only |
| Projects | `/projects` | URL input + project cards |
| Website workspace (owner) | `/projects/:id` | `?comment=&page=&bp=` deep links |
| Website workspace (guest) | `/s/:shareToken` | same UI, no owner controls |
| Comment overview | `/projects/:id/comments`, `/s/:token/comments` | filter All/Open/Resolved, click → page + pin |

## 3. Component inventory

Header (mode toggle, device toggle, pin visibility menu, fullscreen, overview, settings, share) · Sidebar tabs (Pages tree with category/subcategory expand & counts; Comments list with status filter and page scope) · Address bar · Device frame · Pins (open/resolved/attention/selected/pending) · Composer popover (name prompt, textarea, validation, image attach/paste/drop, voice recording, drawing toggle, submit) · Thread popover (resolve/reopen, edit/delete menu, screenshot + download, replies) · Drawing toolbar (arrow, circle, rectangle, freehand, 7 colours, undo, clear, done) · Share dialog · Settings dialog · Lightbox · Toasts · Fullscreen floating bar.

## 4. Design system (implemented)

| Token | Value |
|---|---|
| Font | Inter 400/500/600/700, 14px base, 13px UI controls, 12px meta |
| Text / secondary / muted | `#1d2130` / `#4b5161` / `#8a8f9c` |
| Canvas / surface / border | `#eef0f3` / `#ffffff` / `#e4e6eb` |
| Primary (pins, CTA) | `#5b5bf6` (hover `#4a4ae4`) — *assumption, not measured from MarkUp* |
| Resolved | `#1fa463` (green, required by spec) |
| Attention | `#e8a317` |
| Radius | 6px controls, 8–12px cards/popovers |
| Header / sidebar | 56px / 300px |
| Buttons | 32px (28px small, 40px large) |
| Shadows | three-step elevation (`--shadow-sm/--shadow/--shadow-lg`) |

## 5. Interaction behaviour (implemented)

- Comment mode (default): hover highlights the element under the cursor, click selects it and opens the composer at a pending pin; all page interaction is blocked. Browse mode: the site behaves normally. `C` toggles, `Esc` closes.
- Pins follow their element on scroll, resize and DOM changes; clicking a pin opens its thread.
- Navigation inside the frame updates the address bar, sidebar selection and adds unseen pages to the sitemap.
- External links open in a new browser tab; forms never submit.

## 6. Observed responsive behaviour

Not observable on the reference (blocked). Implemented: desktop (fills canvas), tablet 768px, mobile 375px preview widths; comments are stored per breakpoint and only shown on their own breakpoint.

## 7. Screenshots

Implementation screenshots at 1440×900: `docs/screenshots/01-login.png` … `11-overview.png` (generated by `tests/e2e/visual.spec.js`). No reference screenshots exist (see §0).

## 8. Unknowns and assumptions

Exact MarkUp colours, spacing, typography, icon set, pin shape, popover dimensions, toolbar order, empty/loading/error state copy, keyboard shortcuts, whether comments are per-device, and how MarkUp's proxy handles specific platforms are **unknown** and were designed by us. These should be compared and adjusted once the reference can be accessed.
