CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_workspace ON attachments(workspace_id, created_at);
