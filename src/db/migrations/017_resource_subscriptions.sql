CREATE TABLE resource_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  provider TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  state_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_polled_at TEXT,
  last_event_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (thread_id, provider, resource_kind, resource_key)
);

CREATE INDEX idx_resource_subscriptions_active
  ON resource_subscriptions (active, updated_at);
