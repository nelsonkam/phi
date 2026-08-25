DROP INDEX IF EXISTS outbox_pending;
ALTER TABLE outbox DROP COLUMN status;
ALTER TABLE outbox DROP COLUMN delivery_started_at;
ALTER TABLE outbox DROP COLUMN delivered_at;
ALTER TABLE outbox DROP COLUMN error;
