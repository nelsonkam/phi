ALTER TABLE resource_subscriptions
ADD COLUMN poll_generation INTEGER NOT NULL DEFAULT 0;
