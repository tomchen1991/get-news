-- Explicit operator-authorized policy changes retain old judgments and issues.
CREATE TABLE site_judgment_history (
 authorization_id TEXT NOT NULL,
 article_id TEXT NOT NULL,
 topic_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 archived_at INTEGER NOT NULL,
 PRIMARY KEY(authorization_id,article_id,topic_id)
);
CREATE TABLE site_digest_regenerations (
 day TEXT NOT NULL,
 authorization_id TEXT NOT NULL,
 month TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','published','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 model TEXT NOT NULL,
 diagnostic_json TEXT,
 PRIMARY KEY(day,authorization_id)
);
CREATE INDEX site_digest_regeneration_month ON site_digest_regenerations(month);
CREATE TABLE site_digest_revisions (
 day TEXT NOT NULL,
 authorization_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 archived_at INTEGER NOT NULL,
 PRIMARY KEY(day,authorization_id)
);
