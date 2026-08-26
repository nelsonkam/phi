CREATE TABLE message_search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'processing', 'ready', 'error')),
  UNIQUE (message_id, chunk_index)
);

CREATE INDEX idx_message_search_chunks_workspace
  ON message_search_chunks(workspace_id, id);
CREATE INDEX idx_message_search_chunks_channel
  ON message_search_chunks(workspace_id, channel_id, id);
CREATE INDEX idx_message_search_chunks_embedding
  ON message_search_chunks(embedding_status, id);

CREATE VIRTUAL TABLE message_search_fts USING fts5(
  content,
  content = 'message_search_chunks',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_search_chunks_ai AFTER INSERT ON message_search_chunks BEGIN
  INSERT INTO message_search_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER message_search_chunks_ad AFTER DELETE ON message_search_chunks BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER message_search_chunks_au AFTER UPDATE OF content ON message_search_chunks BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO message_search_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE message_embeddings (
  chunk_id INTEGER PRIMARY KEY
    REFERENCES message_search_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL
);
