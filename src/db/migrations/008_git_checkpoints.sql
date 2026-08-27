CREATE TABLE git_checkpoints (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  commit_sha TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('baseline', 'turn', 'startup', 'manual', 'shutdown')),
  trigger_thread_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX git_checkpoints_workspace_ordinal
  ON git_checkpoints (workspace_id, ordinal);
