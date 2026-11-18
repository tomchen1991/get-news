CREATE TABLE site_news_chat_logins (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX site_news_chat_logins_expiry ON site_news_chat_logins(expires_at);

CREATE TABLE site_news_chat_sessions (
  session_hash TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX site_news_chat_sessions_expiry ON site_news_chat_sessions(expires_at);
