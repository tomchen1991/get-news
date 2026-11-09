PRAGMA foreign_keys = ON;
CREATE TABLE sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind = 'rss'), url TEXT NOT NULL UNIQUE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), etag TEXT, last_modified TEXT,
 next_poll_at INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER, last_success_at INTEGER,
 last_error TEXT, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, interests_json TEXT NOT NULL, excluded_topics_json TEXT NOT NULL DEFAULT '[]',
 min_score INTEGER NOT NULL DEFAULT 75 CHECK(min_score BETWEEN 0 AND 100),
 min_confidence REAL NOT NULL DEFAULT 0.75 CHECK(min_confidence BETWEEN 0 AND 1),
 daily_limit INTEGER NOT NULL DEFAULT 3 CHECK(daily_limit BETWEEN 0 AND 20),
 timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', quiet_start INTEGER NOT NULL DEFAULT 22 CHECK(quiet_start BETWEEN 0 AND 23),
 quiet_end INTEGER NOT NULL DEFAULT 8 CHECK(quiet_end BETWEEN 0 AND 23), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE TABLE articles (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL,
 url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL,
 published_at TEXT, discovered_at INTEGER NOT NULL, eligible INTEGER NOT NULL CHECK(eligible IN (0,1))
);
CREATE INDEX articles_time ON articles(discovered_at DESC);
CREATE TABLE judgments (
 id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id), user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','accepted','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, claim_token TEXT,
 decision_json TEXT, error_code TEXT, profile_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(article_id, user_id)
);
CREATE INDEX judgments_pending ON judgments(status, next_attempt_at);
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL UNIQUE REFERENCES judgments(id), user_id TEXT NOT NULL REFERENCES users(id),
 payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','failed','suppressed')),
 available_at INTEGER NOT NULL DEFAULT 0, reserved_day TEXT, sent_at INTEGER, created_at INTEGER NOT NULL,
 error_code TEXT
);
CREATE INDEX outbox_pending ON outbox(status, available_at);
CREATE TABLE daily_usage (
 user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, reservations INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id, day)
);
CREATE TABLE locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, until_at INTEGER NOT NULL);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
 stats_json TEXT, error_code TEXT
);

CREATE TRIGGER users_limit BEFORE INSERT ON users
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.id) AND (SELECT count(*) FROM users)>=10
BEGIN SELECT RAISE(ABORT,'user_limit'); END;
CREATE TRIGGER sources_limit BEFORE INSERT ON sources
WHEN NOT EXISTS (SELECT 1 FROM sources WHERE id=NEW.id) AND (SELECT count(*) FROM sources)>=20
BEGIN SELECT RAISE(ABORT,'source_limit'); END;
