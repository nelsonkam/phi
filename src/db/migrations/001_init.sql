CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  purpose TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_channels_workspace_name ON channels(workspace_id, name);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_threads_channel ON threads(channel_id, updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author TEXT NOT NULL CHECK (author IN ('user', 'coordinator', 'worker', 'system')),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_messages_thread_seq ON messages(thread_id, seq);
CREATE INDEX idx_messages_workspace_seq ON messages(workspace_id, seq);
