-- Rebuild the thin checkpoint index around insertion order. Timestamps and
-- random checkpoint IDs can tie or sort opposite Git history; AUTOINCREMENT
-- ordinal is the durable sequence. Copy by rowid so legacy 008 tables keep
-- insertion/recovery order (hidden rowid on id TEXT PRIMARY KEY). Revised
-- 008 uses ordinal INTEGER PRIMARY KEY, which aliases rowid.
CREATE TABLE git_checkpoints_ordinal (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  commit_sha TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('baseline', 'turn', 'startup', 'manual', 'shutdown')),
  trigger_thread_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO git_checkpoints_ordinal
  (id, workspace_id, commit_sha, trigger, trigger_thread_id, created_at)
SELECT id, workspace_id, commit_sha, trigger, trigger_thread_id, created_at
FROM git_checkpoints
ORDER BY rowid ASC;

DROP TABLE git_checkpoints;
ALTER TABLE git_checkpoints_ordinal RENAME TO git_checkpoints;

CREATE INDEX git_checkpoints_workspace_ordinal
  ON git_checkpoints (workspace_id, ordinal);
