-- Source labels are assigned by the trusted administrator, never by news content.
ALTER TABLE sources ADD COLUMN topics_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX outbox_user_state ON outbox(user_id,status,created_at);
ALTER TABLE outbox ADD COLUMN reserved_at INTEGER;
