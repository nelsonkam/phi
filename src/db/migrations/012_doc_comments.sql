ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (kind IN ('chat', 'doc_comment'));

CREATE TABLE doc_comment_anchors (
  thread_id    TEXT PRIMARY KEY REFERENCES threads(id),
  root_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  quote        TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  suffix       TEXT NOT NULL,
  heading_slug TEXT
);
CREATE INDEX idx_doc_comment_anchors_doc ON doc_comment_anchors(root_id, path);
