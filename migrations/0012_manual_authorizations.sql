-- Each explicit operator authorization has an immutable identity. Preserve the
-- original failed day's audit; a new authorization never resets paid attempts.
CREATE TABLE site_manual_authorizations (
 day TEXT NOT NULL,
 authorization_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 result TEXT,
 error_code TEXT,
 PRIMARY KEY(day,authorization_id)
);
INSERT INTO site_manual_authorizations(day,authorization_id,status,started_at,finished_at,result,error_code)
 SELECT day,'initial',status,started_at,finished_at,result,error_code FROM site_manual_issues;
-- Keep site_manual_issues unchanged as the original historical audit.
ALTER TABLE site_digest_attempts ADD COLUMN diagnostic_json TEXT;
