# Comment anchoring

Implemented in `server/proxy/client/overlay.js` (runs inside the proxied page; the same code is used by the screenshot worker).

## Captured locator (on click)

| Layer | Field |
|---|---|
| Stable id | `id` (skipped when it looks generated: hashes, long numbers, `react-`, `radix-`, `:r…` …) |
| Stable data attributes | `data-testid`, `data-test`, `data-cy`, `data-qa`, `data-id`, `data-w-id` (Webflow), `data-framer-name` (Framer), `data-section-id/-type` (Shopify), `data-block-id`, `aria-label`, `name`, `role` |
| CSS selector | shortest unique selector from stable id / up to 2 stable classes / `:nth-of-type` |
| DOM path | `body > … > tag:nth-of-type(n)` |
| Attributes | `href`, `src` (unproxied), `alt`, `title`, `type`, `placeholder`, `name`, `aria-label` |
| Text | normalised `textContent` (≤300 chars) |
| Context | text of the previous / next element (prefix/suffix) |
| Fingerprint | tag, stable classes, child count, depth, parent tag/classes, `isImage` |
| Geometry | element rect in document coords, click point as ratio inside the element (`rx`, `ry`), click point in document coords, viewport size |
| Breakpoint | desktop / tablet / mobile + exact viewport width |

Generated class names (`css-*`, `sc-*`, `jsx-*`, `framer-xxxxx`, hashes, state classes like `w--current`, `is-active`) are ignored.

## Resolution

1. Collect candidates: by id, by each data attribute, by selector, by path, and by scanning elements with the same tag whose text or `src`/`href` matches.
2. Score each candidate (tag must match): id 30, data attributes up to 30, selector 20, path 15, text similarity ×35 (penalty −25 when *no* structural signal matched and text differs), attributes up to 18, class overlap ×10, prefix/suffix context ×10, and — only on the same breakpoint — proximity to the stored position ×10 and size similarity ×4.
3. Accept the best candidate when score ≥ 45 **and** it beats the runner-up by ≥ 6 (or scores ≥ 85). Otherwise the anchor is **needs_attention**: the pin is drawn at the last known document position in amber with "!", the thread explains it, and the state is saved so every viewer and the overview see it. A recovered element flips it back to `ok`.
4. The pin is placed at `rect.left + rx·width`, `rect.top + ry·height`, so it follows the element when layout changes.

Positions are recalculated on scroll (capturing, incl. inner scroll containers), resize, any DOM mutation (debounced 120 ms; disconnected elements re-resolved) and every second as a safety net. Positions are viewport coordinates posted to the app, which draws the pins over the iframe; hidden elements (`display:none` at the current breakpoint) hide their pin.

## Breakpoints

Comments are stored with their breakpoint and viewport; a comment is only shown on the breakpoint it was made on. Switching breakpoint changes the frame width (no reload) and re-sends the pin set. Desktop uses the available canvas width; tablet 768 px; mobile 375 px.

## Tested scenarios (`tests/e2e/anchors.spec.js`, `workflow.spec.js`)

Reload ✓ · scroll ✓ · window resize ✓ · text change of the anchored heading ✓ · extra wrapper element (path change) ✓ · three identical-looking cards — pin stays on the 2nd ✓ · element removed → flagged, not re-attached ✓ · element restored → recovers ✓ · tablet-only comment hidden on desktop and re-anchored after reload ✓ · SPA route after client-side navigation ✓.

## Limitations

Elements inside cross-origin iframes, closed shadow roots and `<canvas>` content cannot be anchored individually (the host element is anchored). Large redesigns with changed text and structure will (correctly) flag anchors for attention.
