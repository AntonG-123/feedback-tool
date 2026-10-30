# Proxy compatibility

## Status per platform

**Important:** the build environment has no internet access, so **no real Webflow, WordPress, Shopify, Next.js, Astro or Framer website has been tested yet.** Compatibility was tested with local fixture sites that reproduce each platform's relevant behaviour (`tests/fixtures/sites.js`). Testing against real sites is the first task once the deployment is reachable (see testing-report.md).

| Platform behaviour | Fixture / test | Result |
|---|---|---|
| Static marketing site (Webflow/WordPress style): relative + root-relative + absolute links, `srcset`, lazy `data-src`, CSS `@import` + `url()` + fonts, site JS, root-relative `fetch`, JS-created images, meta CSP, `X-Frame-Options`, analytics/chat/consent scripts | `static.test` · `workflow.spec.js` | ✅ |
| Webflow `data-w-id` anchors, Webflow GET forms | `static.test` | ✅ |
| Webflow password protection (`/.wf_auth`, `wf_auth` cookie) | `wfpass.test` · `proxy.spec.js` | ✅ wrong password → `auth_failed`, none → `auth_required` |
| Shopify storefront password (`/password`, `storefront_digest`) | `shoppass.test` | ✅ |
| SPA client routing (Next.js/Astro/Framer style): `location.pathname` routing, `pushState`, root-relative API fetch, dynamic `import('/assets/…')`, deep-link reload | `spa.test` · `proxy.spec.js` | ✅ |
| Redirects (301) | `static.test/old-page` | ✅ rewritten into the proxy |
| Search forms (GET) allowed, contact forms (POST / JS) blocked | `proxy.spec.js` | ✅ |
| External links | `proxy.spec.js` | ✅ open in a new tab outside the proxy |
| Snapshot render mode | `proxy.spec.js` | ✅ |
| Astro islands (`component-url`), import maps, inline module imports | unit tests (`rewrite.test.js`) | ✅ markup rewriting only |
| WebSockets | implemented (`handleUpgrade`) | ⚠️ **not tested** |
| HTTP Basic auth | implemented | ⚠️ **not tested** |

## Expected platform specifics (to verify on real sites)

- **Webflow** — `webflow.js` + IX2 interactions run from `assets.website-files.com`/`cdn.prod.website-files.com` through the proxy. Forms post to `webflow.com/api/v1/form/…`, which is blocked.
- **WordPress** — plugins vary widely; consent banners (Complianz, CookieYes, Cookie Law Info) hidden; Contact Form 7 / Gravity Forms / WPForms endpoints blocked.
- **Shopify** — `cdn.shopify.com` assets proxied; cart/checkout APIs are proxied but checkout itself is cross-origin and not intended for review.
- **Next.js** — App/Pages router rely on `location.pathname` (restored by the shim) and `/_next/…` chunks (rewritten at runtime). RSC fetches go through the patched `fetch`.
- **Astro** — static output works like static sites; islands/view transitions rely on rewritten `component-url` and Navigation API handling.
- **Framer** — ES modules from `framerusercontent.com` are proxied; pathname-based routing restored. If a Framer site misbehaves, use **Snapshot** mode.

## Known limitations

- Absolute URLs constructed in JavaScript and assigned to CSS properties (e.g. `el.style.backgroundImage = 'url(/x.png)'`) rely on the fallback routing; with third-party cookies blocked (Safari), such requests can fail.
- Site cookies of different proxied sites share one origin (namespaced by host); `localStorage` of different proxied sites is shared on the proxy origin.
- Sites that detect being framed and hide content via JavaScript, bot protection (Cloudflare challenge pages, CAPTCHAs) and sites requiring OAuth logins are not supported.
- Third-party iframes (YouTube, maps, booking widgets) are loaded directly and cannot be commented inside.
- Pages larger than 15 MB HTML are refused with an "Unsupported page" error.
