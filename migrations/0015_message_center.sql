-- Reservation is terminal for automatic sending, even after crashes/timeouts.
CREATE TABLE site_message_deliveries (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('news','digest')),
  local_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','accepted','rejected','unknown')),
  payload_json TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  finished_at INTEGER,
  http_status INTEGER
);
CREATE INDEX site_message_daily_limit ON site_message_deliveries(recipient_id,kind,local_day);
