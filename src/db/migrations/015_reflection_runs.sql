CREATE TABLE reflection_runs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, through_seq)
);

CREATE INDEX idx_reflection_runs_channel_seq
  ON reflection_runs (channel_id, through_seq DESC);
