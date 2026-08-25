ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN effort TEXT CHECK (
  effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh','max','ultra')
);
