PRAGMA defer_foreign_keys = ON;

CREATE TABLE messages_multi_agent (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO messages_multi_agent
  (id, workspace_id, channel_id, thread_id, author, kind, content, metadata_json, seq, created_at)
SELECT
  id,
  workspace_id,
  channel_id,
  thread_id,
  CASE author
    WHEN 'coordinator' THEN 'agent'
    WHEN 'worker' THEN 'agent'
    ELSE author
  END,
  kind,
  content,
  CASE author
    WHEN 'coordinator' THEN json_set(metadata_json, '$.agent', COALESCE(json_extract(metadata_json, '$.agent'), 'default'))
    WHEN 'worker' THEN json_set(metadata_json, '$.agent', COALESCE(json_extract(metadata_json, '$.agent'), 'worker'))
    ELSE metadata_json
  END,
  seq,
  created_at
FROM messages;

CREATE TABLE message_search_chunks_backup AS
SELECT * FROM message_search_chunks;
CREATE TABLE message_embeddings_backup AS
SELECT * FROM message_embeddings;

DROP TRIGGER message_search_chunks_ai;
DROP TRIGGER message_search_chunks_ad;
DROP TRIGGER message_search_chunks_au;
DROP TABLE message_search_fts;
DROP TABLE message_embeddings;
DROP TABLE message_search_chunks;
DROP TABLE messages;
ALTER TABLE messages_multi_agent RENAME TO messages;
CREATE INDEX idx_messages_thread_seq ON messages(thread_id, seq);
CREATE INDEX idx_messages_workspace_seq ON messages(workspace_id, seq);

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

INSERT INTO message_search_chunks
  (id, message_id, workspace_id, channel_id, thread_id, chunk_index, content, content_hash, embedding_status)
SELECT
  id, message_id, workspace_id, channel_id, thread_id, chunk_index, content, content_hash, embedding_status
FROM message_search_chunks_backup;

INSERT INTO message_embeddings
  (chunk_id, model, dimensions, content_hash, embedding, created_at)
SELECT chunk_id, model, dimensions, content_hash, embedding, created_at
FROM message_embeddings_backup;

DROP TABLE message_embeddings_backup;
DROP TABLE message_search_chunks_backup;

CREATE TABLE thread_agent_sessions (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_name),
  UNIQUE (harness_id, session_id)
);

INSERT INTO thread_agent_sessions
  (thread_id, agent_name, harness_id, session_id, model, config_json, last_seen_seq, created_at, updated_at)
SELECT
  s.thread_id,
  s.agent_name,
  s.harness_id,
  s.session_id,
  s.model,
  s.config_json,
  t.last_seq,
  s.created_at,
  s.updated_at
FROM thread_sessions s
JOIN threads t ON t.id = s.thread_id;

DROP TABLE thread_sessions;
