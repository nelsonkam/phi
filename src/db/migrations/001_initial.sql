PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  adapter TEXT NOT NULL,
  dispatch_key TEXT NOT NULL UNIQUE,
  external_run_id TEXT,
  continuation_handle TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('read_only', 'mutating')),
  status TEXT NOT NULL CHECK (status IN ('queued','launching','running','needs_input','cancelling','completing','unknown','completed','failed','cancelled')),
  prompt TEXT NOT NULL,
  observed_start_commit TEXT,
  observed_terminal_commit TEXT,
  error TEXT,
  cancel_key TEXT UNIQUE,
  cancel_requested_by_event_id TEXT REFERENCES events(id),
  cancel_requested_at TEXT,
  launch_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX jobs_adapter_external_run ON jobs(adapter, external_run_id) WHERE external_run_id IS NOT NULL;
CREATE INDEX jobs_status_created ON jobs(status, created_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  source TEXT NOT NULL CHECK (source IN ('user','worker','system')),
  kind TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL,
  obligation_policy TEXT NOT NULL CHECK (obligation_policy IN ('none','outbox')),
  created_at TEXT NOT NULL,
  visible_at TEXT,
  processing_started_at TEXT,
  processed_at TEXT,
  error TEXT
) STRICT;

CREATE UNIQUE INDEX events_dedupe ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX events_claimable ON events(source, created_at, id) WHERE visible_at IS NOT NULL AND processed_at IS NULL;

CREATE TABLE job_followups (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  external_run_id TEXT NOT NULL,
  continuation_handle TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','unknown','stale')),
  created_at TEXT NOT NULL,
  sending_started_at TEXT,
  sent_at TEXT,
  error TEXT
) STRICT;

CREATE INDEX job_followups_pending ON job_followups(created_at) WHERE status IN ('pending','failed');

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('ack','progress','result','question')),
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','delivering','delivered','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  delivery_started_at TEXT,
  delivered_at TEXT,
  error TEXT
) STRICT;

CREATE INDEX outbox_pending ON outbox(created_at) WHERE status IN ('pending','failed');

CREATE TABLE git_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  commit_sha TEXT NOT NULL UNIQUE,
  trigger_job_id TEXT REFERENCES jobs(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
