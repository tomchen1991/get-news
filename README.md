# get-news

一个面向 Cloudflare Workers 的轻量热点追踪服务。

**第一版闭环：RSS/Atom/JSON Feed → 每 20 分钟发现新条目 → LLM 结合用户兴趣判断重要性 → 确定性频控 → webhook 发件箱。**

代码可以离线测试、在本地运行；仓库不含真实凭证，也不会默认调用模型或推送。`LLM_ENABLED` 与 `PUSH_ENABLED` 都默认关闭。示例数据不是你的生产配置。

## 已实现 / 尚未实现

已实现：
- `SourceAdapter` 抽象，RSS / Atom / JSON Feed 实现；ETag / Last-Modified 条件请求，支持 304。
- D1 持久化来源、文章、兴趣配置、判断记录、每日额度、运行状态和发件箱。
- 可配置的 OpenAI-compatible LLM 接口：项目控制提示词，**不传工具、不运行完整 Agent**；严格 JSON 验证，失败不推送。
- 规范化 URL 去重、旧闻过滤、每用户阈值、当地时区/安静时段/每日上限。
- 管理 API，默认关闭模型和推送时可以先检查采集结果。
- 通用 JSON webhook 适配器。请求携带稳定 `Idempotency-Key`，接收方应保存并去重。
- 离线 HTTP mock + SQLite 集成测试、类型检查、Worker 打包、GitHub Actions CI。

尚未实现：
- WebSub 推送订阅：不是所有 RSS 都支持更新事件。第一版使用 **Cron 每 20 分钟轮询**，不是实时通知。
- 自动生成/发送每日综述、自然语言反馈学习、向量库/语义事件合并、自动全文抓取。
- UI、用户登录/多租户权限体系、具体 Telegram/企业微信模板。当前是一个受单一管理密钥保护的轻量管理 API；数据保留 user_id，为后续发展预留空间。

LLM 目前只看**标题、Feed 提供的纯文本摘要和发布时间**，无法独立验证事实，也不读取新闻全文。不同 URL 的转载暂时不会语义合并。RSS 内容和模型输出都不应视为可信指令。

## 结构

```
src/sources/       可插拔采集源（当前 rss）
src/llm/           可替换的重要性判断接口
src/engine.ts     定时流水线、重试与推送策略
src/store.ts      D1 持久化及并发控制
src/notifications.ts  通用 webhook
src/index.ts      Worker HTTP / Cron 入口
migrations/       D1 schema
scripts/          本地示例配置
```

新增来源时实现 `SourceAdapter`，输出标准 `NewsItem`，注册到 `dependencies()`；同时扩展来源配置验证和数据库 kind 约束。不需要改动 LLM 或推送代码。

## 本地运行

要求 Node.js 22+（测试推荐 24），npm。

```sh
npm ci
npm run check
npm run build                  # 只 dry-run 打包，不部署、不调用模型
cp .dev.vars.example .dev.vars
# 设置随机 ADMIN_TOKEN（至少 32 字符）；先保持两项开关 false
npm run db:migrate:local
# 先编辑示例兴趣和来源，再执行；不含任何生产配置
npm run db:seed:local
npm run dev
```

`wrangler.jsonc` 中的全零 database_id 是**明确的占位值**，不是已创建的 Cloudflare 数据库。它用于本地开发；实际部署前需要创建 D1 并替换成返回的真实 ID。`/health` 只证明 Worker HTTP 入口响应，不能证明数据库、来源或外部服务健康。

`wrangler dev --test-scheduled` 可测试本地 Cron；也可以手动执行受保护的 `POST /api/run`。人工执行与 Cron 使用同一分布式锁。

## 配置与管理 API

除 GET `/health` 外，所有请求必须包含 `Authorization: Bearer <ADMIN_TOKEN>`。API 不开放 CORS；勿把管理 Token 放在浏览器前端包或公开链接中。

- `PUT /api/sources`：创建/更新来源；`enabled: false` 暂停。
- `PUT /api/users`：创建/更新兴趣和推送策略；明确修改偏好立即影响后续判断，尚未发送且使用旧兴趣判断的消息会被抑制。
- `GET /api/sources`、`/api/users`：查看配置和来源健康。
- `POST /api/run`：运行一个批次。若 LLM 开启会产生真实推理费用，若推送开启会发送真实消息。
- `GET /api/articles`、`/api/decisions`、`/api/outbox`：各返回最近 100 条。
- `GET /api/status`：最近运行状态、任务积压及开关状态；不返回凭证。

来源示例：

```json
{"id":"cloudflare","name":"Cloudflare Blog","kind":"rss","url":"https://blog.cloudflare.com/rss/","enabled":true}
```

用户示例：

```json
{
  "id":"owner","name":"Owner",
  "interests":["AI 模型与开发工具的重要发布、价格及 API 变化"],
  "excludedTopics":["营销抽奖","未经证实的传闻"],
  "minScore":75,"minConfidence":0.75,"dailyLimit":3,
  "timezone":"Asia/Shanghai","quietStart":22,"quietEnd":8,"enabled":true
}
```

`quietStart == quietEnd` 表示无安静时段，默认 22:00–08:00；Cron 使用 UTC，但推送额度按用户当地日期计算。`dailyLimit: 0` 表示不发送。最多 10 个用户配置、20 个来源（数据库原子约束），不是面向不可信多租户的 SaaS。

## LLM 与推送接入

自行选择 OpenAI-compatible 模型提供商和精确模型 ID，设置以下 **Worker secrets**，不要提交到 Git：

- `ADMIN_TOKEN`
- `LLM_API_KEY`
- `PUSH_WEBHOOK_URL`（如果 URL 自带 token，也当 secret 保存）
- `PUSH_WEBHOOK_TOKEN`（可选 Bearer 认证）

`LLM_BASE_URL` 例如提供商的 `/v1` 根地址，适配器会附加 `/chat/completions`；`LLM_MODEL` 必须明确配置，没有默认收费模型。接口要求支持非流式 `response_format: json_object`、`max_tokens`，不兼容的模型会失败关闭，不会静默降级。

确认提供商、用量预算后开启 `LLM_ENABLED=true`，先保持 `PUSH_ENABLED=false`，检查 `/api/decisions` 和 `/api/outbox`。确认接收渠道、目标与 payload 后再开启 `PUSH_ENABLED=true`。**只关闭推送并不意味着没有模型费用。** 原新闻摘要和兴趣会发给所选模型提供商；不要把隐私信息放入兴趣或订阅源。

Webhook payload：

```json
{
  "version":1,"id":"owner:<article-sha256>","type":"news.alert","userId":"owner",
  "article":{"id":"<article-sha256>","title":"原始标题","url":"https://source.example.com/news","publishedAt":"2026-11-09T00:00:00.000Z"},
  "decision":{"important":true,"shouldPush":true,"score":90,"confidence":0.95,"reason":"与你的兴趣相关的理由","summary":"简短摘要","topics":["AI"]}
}
```

原文链接始终来自经过校验的 feed，不采用模型编造的链接。若将文本送到 HTML、Markdown 或其他聊天系统，接收方必须按自己的输出格式转义。

## 去重、可靠性与成本边界

- 以规范化 URL 的 SHA-256 为文章 ID，去掉 fragment、utm_*、fbclid、gclid；保留其他业务查询参数。同一用户同一文章只建一条判断和一条发件箱记录。
- 初次抓取仅判断最近 24 小时的有日期条目；无日期旧条目只建基线。后续出现的新无日期条目按发现时间处理。Feed 自报时间没有独立验证。
- 每轮最多检查 10 个到期源，每源处理最新 40 条；超过 10 个持续活跃来源可能需要额外一轮，突发超过 40 条可能遗漏，不能承诺全量覆盖。高流量场景应增加分页/队列而非无限提高上限。
- 每轮最多 8 次模型判断（包括重试）；单次 15 秒、最多 600 输出 token。失败指数退避，最多 3 次；过期积压在选取任务前批量清理。模型自报 confidence 只是筛选信号，不是统计校准的真实性概率。
- Cron 每 20 分钟。满负荷理论上可产生 **576 次模型尝试/天**；这只是请求上限，不是货币预算，请在提供商侧设置费用限制。
- 每轮最多 5 次推送尝试；每用户默认每日 3 次。失败和结果不确定也占用当天额度，避免故障重试刷屏。额度不足/安静时段延后，发送前重新检查文章时效。
- D1 租约阻止重叠批次，模型任务有独立 claim token。判断落库和创建 outbox 是原子批次；发送前事务式预留额度。
- webhook 2xx 记为 sent，只代表接收端接受，不保证最终用户已读。4xx 记 failed；5xx、超时、重定向、发送中崩溃记 uncertain。**不自动重发 uncertain/failed**，先查接收端再人工处理。这是避免重复的保守策略，不承诺网络上的 exactly-once。
- 来源失败分别退避，不阻塞其他来源。页面无需每次都产生通知，空结果完全静默。
- 目前不自动删除历史文章/审计记录；长期运行需要增加保留策略及 D1 存储监控。

## 安全约束

HTTP 只接受无用户名密码的公共 HTTPS URL、443 端口，阻断私网 IP/本地主机字面值、拒绝重定向。RSS 响应限 1 MB，拒绝 XML DTD/实体声明，清理 HTML。模型输入、JSON 输出和 webhook 响应均限长，配置读取需要管理密钥。

Workers 中无法可靠预先解析 DNS 并证明最终目标公网，因此**仅可信管理员配置来源和服务地址**；不要暴露任意 URL 抓取给普通用户。生产可进一步限制源主机名单。当前为保守起见拒绝 IPv6 字面地址。需要登录、反爬或浏览器渲染的来源不在第一版范围内。

只记录错误分类，不落原始 HTTP 错误、Authorization 或密钥。D1 内有用户兴趣与新闻判断，管理接口也不适合公开分享。

## 部署（未自动执行）

1. 在你自己的 Cloudflare 账户创建 D1：`npx wrangler d1 create get-news`，把真实 ID 填入配置。
2. `npx wrangler d1 migrations apply get-news --remote`。
3. 配置 Worker secrets 和明确的模型/推送目标。先保持两个开关关闭。
4. `npm run deploy`，再通过管理 API 添加来源和用户，检查采集结果。
5. 分别启用模型与推送，在实际渠道验证消息、重复抑制和时区；勿只看 dry-run 构建就当作上线成功。

仓库 CI 只做安装、类型检查、离线测试和打包，不自动部署，不持有生产密钥。

## 用户画像与 Agent 工具

画像独立保存在 D1：原有 `interests/excludedTopics` 保留，新增版本号 `revision` 和 `preferences`。明确偏好包括主题、来源的 `prefer / less / exclude / digest`；推断兴趣单独记录为 `inferredTopics`（权重 -0.25～0.25，仅给判断模型作为弱提示，不覆盖明确规则）。`delivery` 为 `alert / digest / paused`，另有冷却间隔、每日上限、静默时段。

**更新前先运行新增迁移**（先在本地验证并备份远端数据库，再自行部署）：

```bash
npx wrangler d1 migrations apply get-news --local
# 确认目标 Cloudflare 账号和数据库后，由部署者运行：
npx wrangler d1 migrations apply get-news --remote
```

0002 为已有用户补充默认画像和只追加的变更历史；0003 增加可信来源主题标签和冷却时间索引/字段。旧画像默认行为不变。所有迁移均增量，不清空新闻或用户。

### 接入你的对话 Agent

新闻判断 LLM **仍然没有工具**，不会根据新闻正文修改用户画像。对话 Agent 才能获得以下独立 API。为它配置长度至少 32 的独立 secret `PROFILE_AGENT_TOKEN`，以及普通变量 `PROFILE_AGENT_USER_ID=owner`。这个凭据只能访问绑定用户的画像，不能操作来源、其他用户、运行任务或查看全站记录。管理员 token 仍可维护所有用户。

```bash
npx wrangler secret put PROFILE_AGENT_TOKEN
```

在 Cloudflare 的 Worker 设置或 `wrangler.jsonc` 的 `vars` 中填写 `PROFILE_AGENT_USER_ID`。不要把管理员密钥、模型密钥、推送密钥交给对话模型，也不要在提示词中直接嵌入任何凭据；由工具执行器注入 Authorization header。

| API | 用途 |
| --- | --- |
| `GET /api/profiles/owner` | 当前完整画像与版本 |
| `GET /api/profiles/owner/history` | 最近 50 条变更，包含修改前后、原因、反馈原文和操作者 |
| `GET /api/profiles/owner/tools` | 可注册到 Agent 的 function tool 定义 |
| `POST /api/profiles/owner/tools` | 执行 `{ "name": "get_profile", "arguments": {} }` 等工具调用 |
| `POST /api/profiles/owner/changes` | 提交结构化修改 |
| `POST /api/profiles/owner/undo` | 撤销最近一次变更 |
| `GET /api/profiles/owner/collection-plan` | 预览该用户对已注册来源的采集需求 |

所有上述 API 都要求 `Authorization: Bearer <token>`；POST 要求 JSON、最大 16 KiB。提供 `get_profile / update_profile / list_profile_changes / undo_profile_change / preview_collection_plan` 五个工具。接口已经可用，但本仓不内置聊天机器人或多轮 Agent；把定义注册到你的 Agent，再由执行器转发工具参数即可。

例：用户明确要求少看加密货币新闻、每小时最多一次提醒：

```json
{
  "expectedRevision": 0,
  "changeId": "feedback-20261109-001",
  "reason": "用户明确调整内容与提醒频率",
  "evidence": "加密货币的少推一点，提醒至少隔一小时",
  "operations": [
    { "op": "set_topic", "topic": "加密货币", "mode": "less" },
    { "op": "set_settings", "settings": { "cooldownMinutes": 60 } }
  ]
}
```

- `expectedRevision` 必须与读取版本一致；冲突返回 409，重新读取后重新决定，禁止盲目覆盖。
- `changeId` 是客户端稳定唯一 ID；相同请求重试不会重复更新，不同参数复用 ID 返回 409。
- `reason/evidence` 必填。审计是模型/调用者提供的解释，不代表系统能证明用户确实说过这句话；可信对话层应只提交用户授权的变化。不要写入凭据或无关敏感信息。
- 单次点踩不自动永久屏蔽领域；无回复不作为负反馈。减少推荐用 `less`，明确“不再看”才用 `exclude`。模型推断只使用独立的弱兴趣字段。服务端不会从点击或沉默自动学习。
- 撤销请求将 `operations` 替换为 `targetChangeId`。仅允许撤销当前最新变更，并产生新版本、保留历史，不会擦除记录或重新发送消息。
- 旧 `PUT /api/users` 现在仅创建用户；对已有用户返回 409，请迁移更新调用至版本化接口。

### 采集与推送策略

来源仍由管理员通过 `PUT /api/sources` 注册，不允许模型提交任意抓取 URL。来源可增加 `topics: ["AI", "开发工具"]` 标签。明确偏好影响已注册可信来源的 20/60/180 分钟采集计划；多个用户共享同一来源时取最快需求，故个人预览不等于全局最终抓取间隔。实际检查仍由 20 分钟 Cron 驱动，失败来源保留退避策略。

判断模型接收画像；明确排除/日报/暂停规则还会在服务端再检查。待发候选优先考虑分数与明确偏好，遵守每日预算、静默时间与冷却间隔，而不是见到一条就抢占全部名额。这里只在有限待发候选内比较，不引入额外 LLM 排名费用。

画像每次修改都会在同一事务抑制旧的 pending 消息；发送预订还会核验当前版本，防止旧偏好发送。已预订、正在发送的外部请求不能撤回，已发送/结果不确定的记录不会重放。历史新闻不会因为撤销或改偏好自动补发。

**本版边界：** `digest` 只保留日报候选、不推即时快讯；日报定时汇总与发送尚未实现。没有向量库、兴趣自动衰减、点击反馈采集、自动扩充来源或聊天前端。先让画像更新、审计、来源计划与推荐闭环可用，不额外增加模型调用成本。

## 个性化新闻搜索（Tavily / Cloudflare）

搜索是 RSS 的补充，不替代订阅。默认 `SEARCH_ENABLED=false`，没有真实 API 调用或自动双搜。
启用前先应用 `0004_search.sql`（先本地验证、备份生产 D1，再由部署负责人操作）。本次没有自动部署。

- `SEARCH_PROVIDER=tavily`：固定 News + basic，关闭自动参数升级、答案、正文抽取和图片，一次一个专题，最多 10 条，预留 1 credit。
- `SEARCH_PROVIDER=cloudflare`：调用官方 Web Search REST，固定 **Ceramic**，最多 10 条。不是 Tavily News 的等价新闻索引，不假定结果有发布日期，也不比较两家的相关性分数。CF 是另行计费服务，`credits=0` 仅指没有 Tavily credits，不代表免费。
- 专题从每个启用用户的显式 `interests`、topics 偏好生成；相同专题合并请求，共享结果。排除和暂停生效，prefer 最快 30 分钟，默认 60 分钟，less/digest 180 分钟。轮流处理最久未查询的到期专题，每次最多一个，最多 30 个规范化专题。更多专题会截断，应保持少量清晰类别。
- 推断兴趣、用户名字和反馈证据不外发。但显式兴趣本身仍可能包含隐私：**开启搜索前请审核兴趣标签并授权将其交给选定提供商**。模型修改画像后，下个槽位自动重算计划。
- 默认上海时区 `SEARCH_TIMEZONE=Asia/Shanghai`，08:00 到 22:00（含两端）每半小时，29 槽/日。Cron 改成每 10 分钟唤醒，RSS 仍按原有 20 分钟或画像计划独立采集；仅 00/30 分钟可能搜索。重复 Cron / 手动 `/api/run` 不增加同槽请求，错过不补跑。通知静默时间仍独立控制。
- `TAVILY_DAILY_CREDITS=29`、`TAVILY_MONTHLY_CREDITS=900`；CF 使用独立 `CF_SEARCH_DAILY_REQUESTS=29`、`CF_SEARCH_MONTHLY_REQUESTS=900`。每次请求前 D1 原子预留；失败、超时、崩溃均计入且不退款。不自动重试。31 天最多 899 次，免费额度是 Tavily **账号级**，其他项目消耗不在本地账本，务必同时设供应商限额。日/月按所配时区计算。
- 401/403/配置错误暂停直到管理员修正；429/暂时错误至少等待下个半小时（尊重 Retry-After），配额错误保守暂停到下月。修改 secret 后管理员 `POST /api/search/resume` 清除暂停，不清预算或重放旧槽。
- 首次专题查询只建立基线；后续只有明确且新鲜的日期可进入提醒判断。缺日期、旧日期、未来日期只供发现/查看，不推送。CF 通常无发布日期，因此当前默认仅发现用途，不能虚构日期来制造“实时新闻”。
- canonical URL 与已有 RSS 文章统一去重，judgment/outbox 继续复用既有防重。`search_attempts` 记录查询、来源、保留额度、响应 request ID、状态；`search_results` 保留名次、日期和文章关联。RSS 首次无日期基线规则不变；已存在 RSS 文章的来源/日期不会被搜索覆盖；搜索发现的未提醒文章可由后续明确新鲜日期的 RSS 升级，避免搜索结果阻断 RSS 提醒。

配置：Tavily 用 `wrangler secret put TAVILY_API_KEY`；CF 用 `CF_ACCOUNT_ID`、`wrangler secret put CF_SEARCH_API_TOKEN`，可选 `CF_SEARCH_GATEWAY_ID`。CF token 权限按官方 Web Search 指南的 Workers AI Read / AI Gateway Read，勿用 Global API Key。不要提交 `.dev.vars`。两家只启用选中的一家，不自动回退收费。

管理员 `GET /api/search` 查看有效专题、近 100 次调用及暂停状态；画像代理只能通过自己的 `collection-plan` 查看自己专题，不能操作预算、secret、全局查询记录或恢复接口。

未来对照可用统一 `SearchProvider.search({query,maxResults:10})` 运行同查询、同时间窗的独立离线评测：目前没有自动 A/B 或双倍请求，结果质量与时效需真实样本验证。不要把 CF 缺失日期当搜索失败，也不要把 Tavily/CF 分数横比。

官方依据：[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[CF Web Search 使用](https://developers.cloudflare.com/web-search/how-to-use/)、[CF providers](https://developers.cloudflare.com/web-search/providers/)。接口通过 mock 测试，未使用真实 key 付费验证。
