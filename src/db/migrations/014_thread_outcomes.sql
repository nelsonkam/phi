ALTER TABLE threads ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('worked', 'needed_rework', 'user_corrected'));
