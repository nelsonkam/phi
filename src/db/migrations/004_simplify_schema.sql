-- Consolidate the journal: drop vestigial audit/multi-workspace columns,
-- keep only load-bearing state, and rename outbox to messages (delivery
-- state was removed in 003; it is a plain user-visible message log).

CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  dispatch_key TEXT NOT NULL UNIQUE,
  external_run_id TEXT,
  continuation_handle TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('read_only', 'mutating')),
  model TEXT,
  effort TEXT CHECK (
    effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh','max','ultra')
  ),
  status TEXT NOT NULL CHECK (status IN ('queued','launching','running','needs_input','cancelling','completing','unknown','completed','failed','cancelled')),
  prompt TEXT NOT NULL,
  observed_terminal_commit TEXT,
  error TEXT,
  cancel_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO jobs_new (
  id,adapter,dispatch_key,external_run_id,continuation_handle,mode,model,effort,status,prompt,observed_terminal_commit,error,cancel_key,created_at,started_at,finished_at,updated_at
) SELECT
  id,adapter,dispatch_key,external_run_id,continuation_handle,mode,model,effort,status,prompt,observed_terminal_commit,error,cancel_key,created_at,started_at,finished_at,updated_at
FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE UNIQUE INDEX jobs_adapter_external_run ON jobs(adapter, external_run_id) WHERE external_run_id IS NOT NULL;
CREATE INDEX jobs_status_created ON jobs(status, created_at);

CREATE TABLE job_followups_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
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

INSERT INTO job_followups_new (
  id,job_id,idempotency_key,external_run_id,continuation_handle,content,status,created_at,sending_started_at,sent_at,error
) SELECT
  id,job_id,idempotency_key,external_run_id,continuation_handle,content,status,created_at,sending_started_at,sent_at,error
FROM job_followups;
DROP TABLE job_followups;
ALTER TABLE job_followups_new RENAME TO job_followups;
CREATE INDEX job_followups_pending ON job_followups(created_at) WHERE status IN ('pending','failed');

CREATE TABLE git_checkpoints_new (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO git_checkpoints_new (id,commit_sha,status,created_at)
  SELECT id,commit_sha,status,created_at FROM git_checkpoints;
DROP TABLE git_checkpoints;
ALTER TABLE git_checkpoints_new RENAME TO git_checkpoints;

DROP TABLE workspaces;

ALTER TABLE outbox RENAME TO messages;
