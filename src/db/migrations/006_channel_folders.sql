ALTER TABLE channels
  ADD COLUMN folders_json TEXT NOT NULL DEFAULT '[]';
