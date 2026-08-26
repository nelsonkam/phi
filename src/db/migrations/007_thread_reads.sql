CREATE TABLE thread_reads (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0
);
