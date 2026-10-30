# Local testing

Requirements: **Node.js 22 or newer** (https://nodejs.org) on macOS, Windows or Linux. No database or other software needed — a local PostgreSQL is started automatically.

## 1. Install (once, ~2–3 minutes)

```bash
cd agm-feedback-tool
npm run setup
```

This installs dependencies, downloads the headless Chromium used for screenshots, and builds the app.

## 2. Start

```bash
npm start
```

Then open **http://localhost:3000**

(Stop with Ctrl+C. Data is kept in `./data/` between runs; delete that folder to start fresh.)

## 3. Try it

1. **Log in:** enter any email → click **"Open the login link"** (shown on screen because no email provider is configured locally).
2. **Create a project:** paste a real website URL, e.g. your own Webflow / WordPress / Shopify site.
3. **Comment:** Comment mode is on by default — click any element on the page, write feedback, submit. Try vague text ("Make it bigger.", "Change the image.") to see the validation questions; the Submit button stays disabled until the feedback is specific (or the image is attached).
4. **Draw:** pen icon in the comment box → arrow / circle / rectangle / freehand → Done.
5. **Voice:** microphone icon (Chrome/Edge transcribe while you speak).
6. **Devices:** desktop / tablet / mobile icons in the top bar. Fullscreen: ⤢ icon.
7. **Share:** **Share** button → copy the link → open it in a private window to comment as a guest (no account).
8. **Overview:** "Overview" in the top bar → filter Open/Resolved, click a row to jump to the pin.
9. **Password-protected Webflow/Shopify site:** settings (⚙) → "Password-protected site" → enter the site password.

## Notes

- Ports 3000 (app) and 3001 (website proxy) must be free. Other ports: `PORT=4000 PROXY_PORT=4001 npm start`.
- The guest share link only works on the same computer (it points to `localhost`). For sharing with others, deploy (see README).
- Screenshots appear a few seconds after a comment is submitted.
