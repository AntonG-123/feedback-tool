# AGM Feedback Tool

Website feedback platform in the style of MarkUp.io: enter a URL, share a link, and reviewers click directly on the live website (rendered through our server-side proxy — nothing is installed on the site) to leave numbered, element-anchored comments with drawings, images and voice notes. Vague feedback is caught by a validation step before it can be submitted.

Desktop/laptop application. Previews of the reviewed site: desktop, tablet (768 px), mobile (375 px).

## Quick start (local)

```bash
npm install
npm run build          # builds the React app into dist/
npm start              # app on http://localhost:3000, proxy on http://127.0.0.1:3001
```

Without `DATABASE_URL` an embedded PostgreSQL is started automatically (development only). Without an email provider the login link is printed in the server log and shown on the login screen (`DEV_LOGIN_LINKS`, default on outside production).

## Tests

```bash
npm run test:unit      # validation, SSRF, rewriting, discovery
npx playwright test    # end-to-end against local fixture websites
npm run typecheck
```

## Configuration

See `.env.example`. Key variables: `APP_SECRET`, `DATABASE_URL`, `APP_ORIGIN`, `PROXY_ORIGIN` (must be a different origin than the app), `SERVICE_MODE`, `STORAGE_DIR`, `RESEND_API_KEY` or `SMTP_URL` + `EMAIL_FROM`, optional `ANTHROPIC_API_KEY` (LLM validation), `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` (server transcription).

## Deployment

One Docker image (`Dockerfile`), deployed as two services:

| Service | Env | Domain |
|---|---|---|
| app | `SERVICE_MODE=app`, `PROXY_INTERNAL_ORIGIN=http://<proxy-private-host>:<port>`, volume at `/data` | e.g. `feedback.example.com` |
| proxy | `SERVICE_MODE=proxy` | e.g. `preview.example.com` |

Both need the same `APP_SECRET`, `DATABASE_URL`, `APP_ORIGIN`, `PROXY_ORIGIN`. Health check: `/__agm/health`. `railway.json` is included for Railway.

## Documentation

- `docs/reference-analysis.md` — reference investigation (and what could not be inspected)
- `docs/codebase-audit.md`
- `docs/technical-architecture.md`
- `docs/database-schema.md`
- `docs/proxy-compatibility.md`
- `docs/comment-anchoring.md`
- `docs/testing-report.md`
- `docs/known-limitations.md`
