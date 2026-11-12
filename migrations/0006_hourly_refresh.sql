-- Smooth weighted round-robin for the extra 10:00..20:00 hourly searches.
-- These weights affect collection only, never Jev scoring.
ALTER TABLE site_topics ADD COLUMN refresh_weight INTEGER NOT NULL DEFAULT 1 CHECK(refresh_weight BETWEEN 0 AND 10);
ALTER TABLE site_topics ADD COLUMN refresh_credit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_topics ADD COLUMN last_refresh_at INTEGER;
UPDATE site_topics SET refresh_weight=CASE WHEN priority='core' THEN 3 ELSE 1 END;
ALTER TABLE site_attempts ADD COLUMN topic_id TEXT REFERENCES site_topics(id);
CREATE INDEX site_hourly_history ON site_attempts(kind,topic_id,started_at);
