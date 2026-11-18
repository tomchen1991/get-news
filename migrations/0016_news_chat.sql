-- Only usage counters; never persist questions, keywords, or results.
CREATE TABLE site_news_chat_usage (
 day TEXT PRIMARY KEY,
 turns INTEGER NOT NULL CHECK(turns > 0)
);
