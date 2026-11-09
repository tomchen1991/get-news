-- Preserve populated foreign keys; legacy `kind` remains rss for compatibility.
-- `acquisition` selects real collection mechanism; search is never RSS-polled.
ALTER TABLE sources ADD COLUMN acquisition TEXT NOT NULL DEFAULT 'rss' CHECK(acquisition IN ('rss','search'));
DROP TRIGGER sources_limit;
CREATE TRIGGER sources_limit BEFORE INSERT ON sources
WHEN NEW.acquisition='rss' AND NOT EXISTS(SELECT 1 FROM sources WHERE id=NEW.id) AND (SELECT count(*) FROM sources WHERE acquisition='rss')>=20
BEGIN SELECT RAISE(ABORT,'source_limit'); END;
CREATE TABLE search_attempts (
 id TEXT PRIMARY KEY, slot TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, plan_key TEXT NOT NULL, query TEXT NOT NULL,
 day TEXT NOT NULL, month TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 1,
 started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'reserved',
 error_code TEXT, request_id TEXT, result_count INTEGER, credits REAL
);
CREATE INDEX search_budget ON search_attempts(provider,month,day);
CREATE TABLE search_plan_state (
 provider TEXT NOT NULL, plan_key TEXT NOT NULL, last_attempt_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
 last_success_at INTEGER, PRIMARY KEY(provider,plan_key)
);
CREATE TABLE search_provider_state (provider TEXT PRIMARY KEY, paused_until INTEGER NOT NULL DEFAULT 0, error_code TEXT);
CREATE TABLE search_results (
 attempt_id TEXT NOT NULL REFERENCES search_attempts(id), article_id TEXT NOT NULL REFERENCES articles(id),
 rank INTEGER NOT NULL, published_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(attempt_id,article_id)
);
