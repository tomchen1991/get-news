-- Search membership is recorded at collection time, before asynchronous judging.
-- Only newly queued candidates from hourly searches belong to rolling batches.
CREATE TABLE site_search_items (
 attempt_id TEXT NOT NULL REFERENCES site_attempts(id),
 article_id TEXT NOT NULL,
 topic_id TEXT NOT NULL,
 PRIMARY KEY(attempt_id,article_id),
 FOREIGN KEY(article_id,topic_id) REFERENCES site_candidates(article_id,topic_id)
);
CREATE INDEX site_search_item_candidate ON site_search_items(article_id,topic_id);
