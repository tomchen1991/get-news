-- Additive migration: existing interest lists remain authoritative and unchanged.
ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0 CHECK(profile_revision >= 0);
ALTER TABLE users ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{"topics":[],"sources":[],"inferredTopics":[],"delivery":"alert","cooldownMinutes":0}';

CREATE TABLE profile_changes (
 user_id TEXT NOT NULL REFERENCES users(id),
 change_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('admin','agent')),
 actor_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 evidence TEXT NOT NULL,
 request_json TEXT NOT NULL,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL,
 undo_of TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, change_id),
 UNIQUE(user_id, revision)
);
CREATE INDEX profile_changes_history ON profile_changes(user_id,revision DESC);
CREATE TRIGGER profile_changes_no_update BEFORE UPDATE ON profile_changes
BEGIN SELECT RAISE(ABORT,'immutable_profile_history'); END;
CREATE TRIGGER profile_changes_no_delete BEFORE DELETE ON profile_changes
BEGIN SELECT RAISE(ABORT,'immutable_profile_history'); END;
