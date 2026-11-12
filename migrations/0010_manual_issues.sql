-- Operator-authorized one-off task, dispatched through the existing Cron only.
-- A day can be reserved exactly once, including ambiguous/failed executions.
CREATE TABLE site_manual_issues (
 day TEXT PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 result TEXT,
 error_code TEXT
);
