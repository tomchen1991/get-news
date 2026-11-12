-- Transport-neutral intent only. No delivery or webhook is authorized by this row.
CREATE TABLE site_push_events (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES site_news(id),
  attempt_id TEXT NOT NULL REFERENCES site_attempts(id),
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(recipient_id, article_id)
);
CREATE INDEX site_push_events_created ON site_push_events(created_at, id);
