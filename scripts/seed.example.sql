-- EXAMPLE ONLY: edit interests/sources before applying. Does not enable paid LLM or sending.
INSERT OR IGNORE INTO users(id,name,interests_json,excluded_topics_json) VALUES('owner','Owner','["AI 模型与开发工具的重要发布、价格及 API 变化"]','["营销抽奖","未经证实的传闻"]');
INSERT OR IGNORE INTO sources(id,name,kind,url) VALUES('openai','OpenAI News','rss','https://openai.com/news/rss.xml');
INSERT OR IGNORE INTO sources(id,name,kind,url) VALUES('cloudflare','Cloudflare Blog','rss','https://blog.cloudflare.com/rss/');
