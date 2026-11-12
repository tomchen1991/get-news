-- New read-only personal news site. Legacy tables are retained, not served.
CREATE TABLE site_topics (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN ('core','secondary')),
 weekdays_json TEXT NOT NULL,
 gap_days INTEGER NOT NULL CHECK(gap_days BETWEEN 1 AND 7),
 queries_json TEXT NOT NULL,
 guidance TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
INSERT INTO site_topics(id,name,priority,weekdays_json,gap_days,queries_json,guidance) VALUES
('ai','AI 模型与产品进展','core','[0,1,2,3,4,5,6]',1,'["AI model releases benchmarks coding multimodal capabilities","AI model API pricing rate limits subscription changes","AI assistant product updates new features"]','优先正式发布、可靠实测、价格与额度变化；开发框架归 Agent 频道'),
('agent','Agent 与 AI 开发实践','core','[0,1,2,3,4,5,6]',1,'["AI agent frameworks MCP tool calling open source releases","AI agent memory context management evaluation implementation","AI coding developer tools TypeScript Node.js deployment security releases"]','优先可复用实现、开源项目、部署经验与重要安全漏洞，降低空泛评论权重'),
('nintendo','任天堂与核心游戏资讯','core','[0,1,2,3,4,5,6]',1,'["Nintendo hardware Nintendo Direct first party game announcements release dates","Nintendo games reviews updates release news"]','独立核心兴趣，优先官方发布和可靠评测，传闻降权'),
('devices','手机、数码与跨设备体验','core','[0,1,2,3,4,5,6]',1,'["OPPO ColorOS 手机 AI 系统更新 跨设备互联","Apple Mac iPad macOS iPadOS updates features","Android Mac iPad cross device interoperability updates"]','OPPO X8 与苹果设备实际体验优先，不按品牌阵营与跑分加分'),
('games','单机游戏新闻','core','[0,1,2,3,4,5,6]',1,'["PC Xbox PlayStation single player games announcements release dates reviews","Xbox Game Pass games added leaving announcements","PC console single player games major updates platform policy"]','优先可玩内容和订阅变化；任天堂报道优先归任天堂频道'),
('football','足球','core','[0,5,6]',3,'["武汉三镇 中超 赛程 赛果 转会 俱乐部","Premier League results fixtures transfers major news","UEFA Champions League results fixtures major news"]','武汉三镇、中国足球、英超和欧冠均属核心兴趣；区分确认转会和传闻'),
('ev','智能汽车与特斯拉','secondary','[0,4]',4,'["Tesla Model 3 software OTA updates electric vehicle technology","特斯拉 Model 3 中国 辅助驾驶 OTA 车主权益"]','2021 款 Model 3 车主相关性优先；纯电技术优先，降低新车营销权重'),
('wuhan','武汉本地实用资讯','secondary','[0,4]',4,'["武汉 交通 公共服务 调整 通知","武汉 亲子活动 场馆 开放 预约"]','重实用性；如来源有提供，保留预约、排队与人流成本；不可编造'),
('health','育儿、健康与力量训练','secondary','[0,4]',4,'["child health safety pediatric guideline evidence updates","parenting systematic review evidence guideline","strength training recovery systematic review guidelines"]','低频精选，指南与可靠证据优先；未提供孩子年龄，不推断适龄性，拒绝焦虑营销与伪科学');
CREATE TABLE site_query_state (
 id TEXT PRIMARY KEY,
 last_success_at INTEGER NOT NULL
);
CREATE TABLE site_attempts (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('search','jev')),
 day TEXT NOT NULL,
 month TEXT NOT NULL,
 ref TEXT NOT NULL,
 units INTEGER NOT NULL DEFAULT 1 CHECK(units > 0),
 status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 error_code TEXT
);
CREATE INDEX site_attempt_budget ON site_attempts(kind,month,day);
CREATE TABLE site_provider_state (
 provider TEXT PRIMARY KEY,
 reason TEXT NOT NULL,
 until_at INTEGER
);
CREATE TABLE site_news (
 id TEXT PRIMARY KEY,
 url TEXT NOT NULL,
 title TEXT NOT NULL,
 summary TEXT NOT NULL,
 published_at TEXT,
 discovered_at INTEGER NOT NULL
);
CREATE TABLE site_candidates (
 article_id TEXT NOT NULL REFERENCES site_news(id),
 topic_id TEXT NOT NULL REFERENCES site_topics(id),
 status TEXT NOT NULL CHECK(status IN ('baseline','pending','evaluating','accepted','rejected','failed','expired')),
 score REAL,
 evaluation_json TEXT,
 created_at INTEGER NOT NULL,
 evaluated_at INTEGER,
 PRIMARY KEY(article_id,topic_id)
);
CREATE INDEX site_candidate_queue ON site_candidates(status,created_at);
CREATE TABLE site_locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, until_at INTEGER NOT NULL);
CREATE TABLE site_runs (
 id TEXT PRIMARY KEY,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed')),
 searches INTEGER NOT NULL DEFAULT 0,
 evaluations INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0
);
