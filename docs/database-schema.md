# Database schema

PostgreSQL. Source of truth: `server/db/migrations/001_init.sql` (applied automatically at start-up; applied migrations are tracked in `schema_migrations`).

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `users` | project owners | `email` unique |
| `magic_links` | login links | `token_hash` (SHA-256) unique, `expires_at`, `used_at` |
| `sessions` | owner sessions | `token_hash` unique, `expires_at` |
| `projects` | one website | `owner_id`, `url`, `origin`, `render_mode` (live/snapshot), `site_auth_type`, `site_auth_secret_enc` + `site_auth_state_enc` (AES-GCM), `discovery_status`, `next_comment_number` |
| `share_links` | guest access | `token` unique, `enabled`, `expires_at`, `revoked_at` |
| `pages` | discovered/visited pages | unique (`project_id`, `url`); `path`, `title`, `source` (start/sitemap/crawl/visited) |
| `guests` | guest identities | `name`, `secret_hash` |
| `breakpoints` | desktop / tablet (768) / mobile (375) | seeded |
| `comments` | threads **and** replies | `parent_id` NULL = thread root; `number` (roots, unique per project), `breakpoint`, author (`author_user_id` or `author_guest_id` + `author_name`), `body`, `status` open/resolved, `resolved_at/by`, `edited_at` |
| `comment_anchors` | 1:1 with root comment | `locator` jsonb (layered locator), `offset_rx/ry`, `doc_x/doc_y`, `viewport_w/h`, `breakpoint`, `state` ok/needs_attention |
| `drawings` | 1:1 with root comment | `shapes` jsonb: `[{type, color, width, points:[{x,y,rel:{x,y}}]}]` (document coords + element-relative) |
| `attachments` | images & audio (files in storage) | `kind`, `storage_key`, `mime`, `size_bytes`, `uploader_key`, `comment_id` (NULL until submitted) |
| `transcriptions` | 1:1 with audio attachment | `text`, `provider` (browser-speech/openai/deepgram), `status`, `error` |
| `screenshots` | `full` + `crop` per comment | unique (`comment_id`, `kind`), `status` pending/ready/failed, `storage_key`, `width/height`, `page_url`, `viewport_w`, `error` |
| `jobs` | durable job queue | `type`, `payload`, `status`, `attempts`, `run_at` |
| `notification_queue` | comments to notify the owner about | `batch_id` NULL = pending |
| `notification_batches` | sent digests | `owner_id`, `comment_count`, `delivery`, `sent_at` |

Indexes support: project comments by date (`comments_project_idx`), comments by page + breakpoint (`comments_page_idx`), by status (`comments_status_idx`), thread replies (`comments_parent_idx`), ready jobs, pending notifications per owner, last batch per owner.

Binary data is never stored in the database — only `storage_key` references (`server/lib/storage.js`). Deleting a project cascades to everything; deleting a comment cascades to anchor, drawing, screenshots, attachments, replies (files removed from storage by the API).
