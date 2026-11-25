-- =============================================================================
-- @local/dsh-hub — SQLite Durable State Schema (Node 24 `node:sqlite`)
-- =============================================================================
-- Primary DB:  ~/.dsh/storages/hub/state.sqlite (or lossless fallback to watcher)
-- Lease DB:    <stateDir>/automation-owner.sqlite
--              (PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;)
--
-- 16 STRICT tables:
--   Core 11:
--     1. owner_lease          — Single-writer lease metadata & heartbeat
--     2. runtime_meta         — config_revision CAS & runtime KV
--     3. source_cursors       — Per-adapter cursors / ETag / Last-Modified
--     4. entities             — Normalized external entities (Issue / PR / Chat)
--     5. entity_edges         — Directed entity graph (tight / loose edges)
--     6. workstreams          — Workstream <-> DSH Session hybrid topology
--     7. inbox_items          — Zero-token unified inbox & strong dedupe log
--     8. staged_drafts        — Draft-and-Approve outbound drafts & uncertain audit
--     9. delivery_receipts    — Session delivery receipts & crash recovery
--    10. circuit_breaker_log  — Global hourly auto-session / cold-wake counters
--    11. thread_subscriptions — Fast-path (source, thread_key) -> session bindings
--   Legacy / Compat Persona Tables (owned by @local/dsh-persona, retained for lossless compatibility):
--    12. personas
--    13. persona_memory
--   Proactive Memos:
--    14. memos
--    15. memo_seen_urls
--    16. proactive_budget
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS owner_lease (
  lease_name    TEXT PRIMARY KEY,
  holder_pid    INTEGER NOT NULL,
  holder_id     TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS source_cursors (
  source_id     TEXT NOT NULL,
  cursor_key    TEXT NOT NULL,
  cursor_value  TEXT NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  config_rev    INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source_id, cursor_key)
) STRICT;

CREATE TABLE IF NOT EXISTS entities (
  entity_key     TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'open',
  raw_url        TEXT,
  last_event_id  TEXT,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_entities_source_updated
  ON entities (source, updated_at DESC);

CREATE TABLE IF NOT EXISTS entity_edges (
  id               TEXT PRIMARY KEY,
  from_entity_key  TEXT NOT NULL,
  to_entity_key    TEXT NOT NULL,
  relation         TEXT NOT NULL
                   CHECK (relation IN ('fixes', 'closes', 'implements', 'linked_pr', 'cross_referenced', 'manual_link', 'supersedes')),
  strength         TEXT NOT NULL CHECK (strength IN ('tight', 'loose')),
  evidence         TEXT,
  discovered_at    TEXT NOT NULL,
  UNIQUE (from_entity_key, to_entity_key, relation)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges (from_entity_key);
CREATE INDEX IF NOT EXISTS idx_entity_edges_to   ON entity_edges (to_entity_key);

CREATE TABLE IF NOT EXISTS workstreams (
  id                   TEXT PRIMARY KEY,
  source               TEXT NOT NULL,
  workstream_key       TEXT NOT NULL UNIQUE,
  primary_entity_key   TEXT NOT NULL,
  entity_keys_json     TEXT NOT NULL,
  workspace_path       TEXT NOT NULL,
  session_id           TEXT,
  superseded_by        TEXT,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'awaiting_agent', 'paused', 'ended')),
  end_reason           TEXT,
  mode                 TEXT NOT NULL DEFAULT 'once' CHECK (mode IN ('once', 'repeat')),
  trust_mode           TEXT NOT NULL DEFAULT 'triage' CHECK (trust_mode IN ('triage', 'autonomous')),
  delivery_count       INTEGER NOT NULL DEFAULT 0,
  max_wakeups          INTEGER NOT NULL DEFAULT 1,
  ttl_expires_at       TEXT NOT NULL,
  last_wakeup_at       TEXT,
  self_write_watermark TEXT,
  config_revision      INTEGER NOT NULL DEFAULT 1,
  metadata_json        TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workstreams_session_active
  ON workstreams (session_id, status)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workstreams_status_ttl
  ON workstreams (status, ttl_expires_at);

CREATE TABLE IF NOT EXISTS inbox_items (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL UNIQUE,
  dedupe_key     TEXT NOT NULL UNIQUE,
  thread_key     TEXT NOT NULL,
  source         TEXT NOT NULL,
  type           TEXT NOT NULL,
  entity_key     TEXT,
  workstream_id  TEXT,
  session_id     TEXT,
  actor          TEXT NOT NULL,
  actor_is_bot   INTEGER NOT NULL DEFAULT 0,
  trust_level    TEXT NOT NULL CHECK (trust_level IN ('untrusted', 'triage', 'owner', 'system')),
  summary        TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  tier           TEXT NOT NULL CHECK (tier IN ('inbox-only', 'triage', 'review', 'autonomous')),
  verdict        TEXT CHECK (verdict IN ('ACTION_REQUIRED', 'CONFLICT_OR_STALE', 'OBSOLETE_OR_DUPLICATE', 'INFO_ONLY')),
  pre_gate_tags  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'unread'
                 CHECK (status IN ('unread', 'triaged', 'action_required', 'resolved', 'muted')),
  raw_url        TEXT,
  occurred_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_inbox_status_created
  ON inbox_items (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_thread_time
  ON inbox_items (thread_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_session
  ON inbox_items (session_id)
  WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS staged_drafts (
  id              TEXT PRIMARY KEY,
  sink_id         TEXT NOT NULL,
  sink_kind       TEXT NOT NULL CHECK (sink_kind IN ('idempotent', 'staged-draft', 'irreversible-gui')),
  action          TEXT NOT NULL,
  workstream_id   TEXT,
  session_id      TEXT,
  target_json     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  preview_text    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval', 'approved', 'executing', 'executed', 'uncertain', 'rejected', 'expired')),
  receipt_json    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_drafts_status
  ON staged_drafts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_receipts (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  message_id      TEXT NOT NULL UNIQUE,
  event_ids_json  TEXT NOT NULL,
  trust_mode      TEXT NOT NULL CHECK (trust_mode IN ('triage', 'autonomous')),
  state           TEXT NOT NULL
                  CHECK (state IN ('queued', 'in_flight', 'delivered', 'uncertain', 'suppressed_takeover', 'failed')),
  manual_takeover INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  delivered_at    TEXT NOT NULL,
  settled_at      TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_receipts_open
  ON delivery_receipts (state, session_id)
  WHERE state IN ('queued', 'in_flight');

CREATE TABLE IF NOT EXISTS circuit_breaker_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket      TEXT NOT NULL,
  ref_key     TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_breaker_bucket_time
  ON circuit_breaker_log (bucket, created_at);

CREATE TABLE IF NOT EXISTS thread_subscriptions (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  thread_key    TEXT NOT NULL,
  workstream_id TEXT,
  session_id    TEXT NOT NULL,
  persona_id    TEXT,
  owner         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(source, thread_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_thread_subscriptions_source_status
  ON thread_subscriptions (source, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_thread_subscriptions_session
  ON thread_subscriptions (session_id, status);

CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  config      TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT '',
  style_meta  TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS persona_memory (
  id          INTEGER PRIMARY KEY,
  persona_id  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  event_seq   INTEGER NOT NULL,
  note        TEXT NOT NULL,
  quote       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  source_key  TEXT,
  category    TEXT NOT NULL DEFAULT '聊天偏好',
  metadata    TEXT NOT NULL DEFAULT '{}',
  UNIQUE (persona_id, scope, event_seq, note)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS persona_memory_source
  ON persona_memory (persona_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_persona_memory_persona_scope
  ON persona_memory (persona_id, scope, id DESC);

CREATE TABLE IF NOT EXISTS memos (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL
                        CHECK (kind IN ('time_nudge', 'news_followup', 'long_watch')),
  room_key              TEXT NOT NULL,
  target_session_id     TEXT,
  target_chat_id        TEXT,
  source                TEXT NOT NULL DEFAULT 'manual',
  title                 TEXT NOT NULL DEFAULT '',
  basis                 TEXT NOT NULL,
  window_start          TEXT,
  window_end            TEXT,
  random_fire_at        TEXT,
  interval_hours        REAL,
  expires_at            TEXT,
  keywords_json         TEXT NOT NULL DEFAULT '[]',
  known_facts_json      TEXT NOT NULL DEFAULT '[]',
  accept_criteria       TEXT,
  official_domains_json TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'fired', 'torn', 'completed', 'expired')),
  last_checked_at       TEXT,
  next_check_at         TEXT,
  notify_wechat_chat_id TEXT,
  result_summary        TEXT,
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memos_status_next_check
  ON memos (status, next_check_at);

CREATE INDEX IF NOT EXISTS idx_memos_room_status
  ON memos (room_key, status);

CREATE TABLE IF NOT EXISTS memo_seen_urls (
  memo_id      TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  verdict      TEXT NOT NULL DEFAULT 'seen',
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (memo_id, url)
) STRICT;

CREATE TABLE IF NOT EXISTS proactive_budget (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_key     TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'wechat',
  memo_id      TEXT,
  sent_at      TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX IF NOT EXISTS idx_proactive_budget_room_time
  ON proactive_budget (room_key, sent_at DESC);

INSERT OR IGNORE INTO runtime_meta (key, value, updated_at)
VALUES ('config_revision', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
