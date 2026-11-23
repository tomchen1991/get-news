-- One terminal reservation per production Worker version, independent of news quotas.
CREATE TABLE site_release_deliveries (
 version_id TEXT PRIMARY KEY,
 reserved_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','accepted','unknown','rejected')),
 http_status INTEGER
);
