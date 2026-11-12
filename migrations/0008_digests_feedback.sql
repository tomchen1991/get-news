-- Published digests are immutable snapshots; model failures never create one.
CREATE TABLE site_digest_attempts (
 day TEXT PRIMARY KEY,
 month TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','published','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 model TEXT NOT NULL,
 error_code TEXT
);
CREATE INDEX site_digest_month ON site_digest_attempts(month);
CREATE TABLE site_digests (
 day TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 overview TEXT NOT NULL,
 stories_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 model TEXT NOT NULL,
 policy_version INTEGER NOT NULL,
 profile_json TEXT NOT NULL,
 input_json TEXT NOT NULL,
 pending_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE site_digest_sources (
 day TEXT NOT NULL REFERENCES site_digests(day),
 article_id TEXT NOT NULL,
 topic_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 PRIMARY KEY(day,article_id)
);
CREATE INDEX site_digest_article ON site_digest_sources(article_id);
-- Includes editor omissions so unchanged declined candidates are not resubmitted daily.
CREATE TABLE site_digest_inputs (
 day TEXT NOT NULL REFERENCES site_digests(day),
 article_id TEXT NOT NULL,
 PRIMARY KEY(day,article_id)
);
CREATE INDEX site_digest_considered ON site_digest_inputs(article_id);
CREATE TABLE site_feedback (
 user_id TEXT NOT NULL,
 article_id TEXT NOT NULL REFERENCES site_news(id),
 topic_id TEXT NOT NULL REFERENCES site_topics(id),
 kind TEXT CHECK(kind IN ('more','uninterested','duplicate','quality')),
 note TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,article_id,topic_id)
);
CREATE TABLE site_feedback_events (
 request_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 article_id TEXT NOT NULL,
 topic_id TEXT NOT NULL,
 kind TEXT CHECK(kind IN ('more','uninterested','duplicate','quality')),
 note TEXT NOT NULL,
 expected_revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX site_feedback_rate ON site_feedback_events(user_id,created_at);
CREATE INDEX site_feedback_topic ON site_feedback(topic_id,updated_at);
