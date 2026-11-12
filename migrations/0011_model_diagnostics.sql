-- Private operator diagnostics, including one-shot synthetic Jev smoke results.
ALTER TABLE site_attempts ADD COLUMN diagnostic_json TEXT;
