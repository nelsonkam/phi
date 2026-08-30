CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  handler TEXT NOT NULL,
  schedule_kind TEXT NOT NULL
    CHECK (schedule_kind IN ('interval', 'cron')),
  schedule_value TEXT NOT NULL,
  timezone TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  catch_up TEXT NOT NULL DEFAULT 'run_once'
    CHECK (catch_up IN ('run_once', 'skip')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT,
  last_run_at TEXT,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_scheduled_tasks_due
  ON scheduled_tasks (enabled, next_run_at);
