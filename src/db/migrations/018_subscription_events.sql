ALTER TABLE resource_subscriptions
ADD COLUMN events_json TEXT NOT NULL DEFAULT
  '["state_changed","draft_changed","review_decision_changed","checks_failed","checks_passed","new_review","new_commit"]';
