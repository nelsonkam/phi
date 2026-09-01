CREATE TABLE channel_checkpoints (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO channel_checkpoints (channel_id, through_seq, updated_at)
SELECT channel_id, MAX(through_seq), MAX(created_at)
FROM reflection_runs
GROUP BY channel_id;

DROP TABLE reflection_runs;
