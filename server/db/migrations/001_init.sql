-- AGM Feedback Tool: initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE magic_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX magic_links_email_idx ON magic_links (email, created_at DESC);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  url                  text NOT NULL,           -- start URL entered by the owner
  origin               text NOT NULL,           -- scheme://host[:port] of the site
  render_mode          text NOT NULL DEFAULT 'live' CHECK (render_mode IN ('live','snapshot')),
  -- Site authentication (password-protected Webflow/Shopify, HTTP basic)
  site_auth_type       text NOT NULL DEFAULT 'none' CHECK (site_auth_type IN ('none','webflow','shopify','basic')),
  site_auth_user       text,
  site_auth_secret_enc text,                    -- AES-256-GCM, never plaintext
  site_auth_state_enc  text,                    -- encrypted auth cookies obtained by the proxy
  discovery_status     text NOT NULL DEFAULT 'pending' CHECK (discovery_status IN ('pending','running','done','failed')),
  discovery_error      text,
  next_comment_number  integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects (owner_id, created_at DESC);

CREATE TABLE share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,             -- 32 random bytes, base64url
  enabled     boolean NOT NULL DEFAULT true,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_project_idx ON share_links (project_id);

CREATE TABLE pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         text NOT NULL,                    -- normalized absolute URL
  path        text NOT NULL,                    -- pathname + search
  title       text,
  source      text NOT NULL DEFAULT 'crawl' CHECK (source IN ('start','sitemap','crawl','visited')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, url)
);

CREATE TABLE guests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  secret_hash text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE breakpoints (
  id     text PRIMARY KEY,
  label  text NOT NULL,
  width  integer,          -- NULL = fills available width
  height integer
);
INSERT INTO breakpoints (id, label, width, height) VALUES
  ('desktop', 'Desktop', NULL, NULL),
  ('tablet',  'Tablet',  768, 1024),
  ('mobile',  'Mobile',  375, 812);

CREATE TABLE comments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES comments(id) ON DELETE CASCADE,   -- NULL = thread root
  number           integer,                                         -- pin number, roots only
  breakpoint       text REFERENCES breakpoints(id),                 -- roots only
  author_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  author_guest_id  uuid REFERENCES guests(id) ON DELETE SET NULL,
  author_name      text NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_at      timestamptz,
  resolved_by_name text,
  edited_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (author_user_id IS NOT NULL OR author_guest_id IS NOT NULL)
);
CREATE INDEX comments_project_idx ON comments (project_id, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX comments_page_idx ON comments (page_id, breakpoint) WHERE parent_id IS NULL;
CREATE INDEX comments_status_idx ON comments (project_id, status) WHERE parent_id IS NULL;
CREATE INDEX comments_parent_idx ON comments (parent_id, created_at);
CREATE UNIQUE INDEX comments_number_uq ON comments (project_id, number) WHERE parent_id IS NULL;

CREATE TABLE comment_anchors (
  comment_id     uuid PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  breakpoint     text NOT NULL REFERENCES breakpoints(id),
  viewport_w     integer NOT NULL,
  viewport_h     integer NOT NULL,
  -- layered locator: id, data attributes, css selector, dom path, attributes,
  -- text quote, prefix/suffix context, fingerprint, element rect
  locator        jsonb NOT NULL,
  offset_rx      real NOT NULL,      -- click point inside element, 0..1
  offset_ry      real NOT NULL,
  doc_x          real NOT NULL,      -- document coordinates at creation (fallback)
  doc_y          real NOT NULL,
  state          text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','needs_attention')),
  last_checked_at timestamptz
);

CREATE TABLE drawings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid NOT NULL UNIQUE REFERENCES comments(id) ON DELETE CASCADE,
  -- [{type:'arrow'|'circle'|'rect'|'free', color, width, points:[{x,y}]}]
  -- points are document coordinates, plus element-relative copies (rel)
  shapes      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  comment_id    uuid REFERENCES comments(id) ON DELETE CASCADE,    -- NULL until the comment is submitted
  kind          text NOT NULL CHECK (kind IN ('image','audio')),
  storage_key   text NOT NULL,
  mime          text NOT NULL,
  size_bytes    integer NOT NULL,
  original_name text,
  uploader_key  text NOT NULL,     -- user:<id> or guest:<id>, enforces who may attach it
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_comment_idx ON attachments (comment_id);

CREATE TABLE transcriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE CASCADE,
  text          text,
  provider      text NOT NULL,     -- browser-speech | openai | deepgram
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done','failed')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE screenshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id   uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('full','crop')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  storage_key  text,
  width        integer,
  height       integer,
  page_url     text,
  viewport_w   integer,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, kind)
);

CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (status, run_at) WHERE status = 'queued';

CREATE TABLE notification_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_count integer NOT NULL,
  delivery      text NOT NULL,    -- resend | smtp | log
  sent_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_batches_owner_idx ON notification_batches (owner_id, sent_at DESC);

CREATE TABLE notification_queue (
  id          bigserial PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  batch_id    uuid REFERENCES notification_batches(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_queue_pending_idx ON notification_queue (owner_id) WHERE batch_id IS NULL;
