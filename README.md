# get-news

Cloudflare Workers + D1 的个人新闻站：**定时搜索 → Jev 结构化评估 → 中文日报与历史档案 → 私人反馈改善未来判断**。

首版站点：<https://get-news.fzt-tom.workers.dev>（公开只读页面；采集、单次 Noul Jev 和日报生成已开启，反馈关闭。2026-11-11 日报已用 `@cf/deepseek-ai/deepseek-v4.1-flash-1017` 成功发布，正文 210 字、4 个事件附来源。运行记录见 [生产状态](docs/production-status.md)）。

当前生产入口为 `src/site/index.ts`，不开放管理、画像修改、手动运行或推送接口，**不需要 ADMIN_TOKEN，不发送 webhook**。历史 MVP 代码与数据表暂留，但没有接入当前部署入口，说明见 [历史文档](docs/legacy-mvp.md)。

## 已实现与边界

- D1 按专题保存关注规则、子查询、语言（由搜索词体现）、执行日期与启用状态。
- Tavily News + basic，每条查询最多 10 条，不生成答案、不自动升级、不自动扩搜。
- Jev `typesafe/jev-1.14.0` 通过 `AI` binding 和指定 AI Gateway 调用，无工具、无浏览权限。
- 固定完整画像 + 历史弱反馈注入 Jev，只问一次 Noul：“这条新闻是否值得主人花时间阅读？”返回 yes 概率用于排序，不加权、不设分数门槛。频道仅用于采集组织，不限制评估领域。
- D1 预留预算、规范 URL 去重、日期过滤、Cron 互斥、错误审计。
- `/` 为公开只读的白天滚动标题页，`GET /api/updates` 按小时搜索批次返回最多三条标题和原文链接；整批评分结束后才展示，保留最近 14 天内最多 33 轮。`GET /api/news` 保留原入选新闻投影。浏览页面不会搜索、评估或发送消息。
- 可选主模型经同一 Gateway 生成中文日报：全领域 Jev 分数前 10 条进入二次筛选，整篇正文 200–300 字，合并同事件报道并保留来源引用，提供 `/daily` 历史列表和日期链接。白天滚动不调用主模型。
- 可选 Cloudflare Access 保护的个人新闻反馈，支持原因、撤销、并发版本检查与审计；只作为未来评估的弱参考，不自动改写画像或旧日报。

滚动页 `/` 仅展示每轮最高分的最多三条来源标题和链接，标题可能为英文；中文日报位于 `/daily/YYYY-MM-DD`。仅做确定性的规范 URL 去重，不增加 Jev 语义去重。不同 URL 的同事件合并仅由晨间日报主模型完成，不能保证语义去重正确；白天滚动仍可能有重复事件。不把 Tavily 排名当热度，也不把 Jev 分数当事实验证。

## 采集计划

默认北京时间 **07:00–10:00（不含 10:00）** 完成晨间采集。Cron 每 10 分钟唤醒，晨间每轮最多 3 条搜索，每条子查询的晨间请求每天最多尝试一次；逐批完成当天计划，不在浏览请求中启动工作。

此外，**10:00、11:00……20:00（含两端）各增加一次搜索，每天 11 次**。每次只选一个频道的一条子查询，不是全频道刷新。

| 频道 | 子查询数 | 执行日 |
| --- | ---: | --- |
| AI 模型与产品进展 | 3 | 每天 |
| Agent 与 AI 开发实践（含开发工具） | 3 | 每天 |
| 任天堂 | 2 | 每天 |
| 手机、数码与跨设备体验 | 3 | 每天 |
| 单机游戏（含 XGP） | 3 | 每天 |
| 武汉三镇 / 中国足球、英超、欧冠 | 3 | 周五、六、日 |
| 智能汽车与特斯拉 | 2 | 周四、日 |
| 武汉本地实用资讯 | 2 | 周四、日 |
| 育儿、健康与力量训练 | 3 | 周四、日 |

完整查询初稿在 `migrations/0005_news_site.sql`，小时轮转配置在 `0006_hourly_refresh.sql`，`0007_core_only_hourly.sql` 将低频频道移出小时轮转。晨间 121 次 + 小时刷新 77 次 = **198 次 basic 搜索/周，平均约 860 credits/月**；按 31 天保守上界约 890 credits，默认月预算 950。日报模型费用不包含其中，其他项目仍会共享账号额度。

### 小时刷新如何分配

- 白天仅轮转核心频道，足球仍仅周五六日参与。汽车/武汉/健康不参加白天轮转，只保留周四和周日的晨间采集。
- D1 `site_topics.refresh_weight`：核心频道默认 **3**，低频频道 **0**；同级频道同权，不默认偏爱技术。`0` 表示不参加小时刷新，不影响晨间采集。
- 使用持久化的平滑加权轮转，累计权重欠账，避免每天从头总选同一频道；这只是采集重要性，不改变 Jev 的评分规则。
- 选中频道后，请求其**最久未尝试的子查询**（晨间与小时历史合并计算），不是每次请求整个频道的所有查询。
- 每个本地日期/小时只有一个 D1 预算预留键；重复 Cron、失败或崩溃都不自动换频道重试。预算不足不会消耗轮转权重。
- 使用 Cron 原定时间识别槽位，容忍最多 5 分钟的调度延迟；非整点的 Cron 只处理评估队列，不补搜错过的小时。
- 默认每天搜索总数：周一二三各 25、周四 32、周五六各 28、周日 35。固定查询仍是可调整初稿，不代表完整覆盖。

- 所有查询使用重叠窗口：至少回看“专题间隔 + 1 天”，漏跑时扩展到上次成功查询，最多 14 天。查询使用本地日期，程序再做精确时间过滤；上次搜索时间不再作为新报道的发布时间门槛。
- 首次搜索也接纳窗口内有明确日期的报道，按 canonical URL 去重；晚搜到的旧报道仍可进入评分。无日期、过旧或未来超过 5 分钟的条目不进入评分。明确的 IGN `/playlist/` 收藏页在采集前排除，不增加评分门槛。旧 baseline 再次被搜到且符合窗口时可恢复为待评估。
- 无日期、窗口外、超过 5 分钟的未来日期不发布；搜索自报日期未独立验证。
- 晨间之外继续分批评估积压，每轮最多 8 次 Jev 请求；候选等待超过 48 小时过期。小时搜索仅将新进入评估队列的候选归入本轮，已知 URL 不重复入轮；本轮所有候选完成或过期后，按分数、发布日期和 ID 排序，取最多三条已入选标题，不足不凑数，评分失败不编造结果。迁移前的小时搜索无法还原批次成员，不补造历史。
- 原 `GET /api/news` 仍展示最近 14 天入选内容，最多 100 条，每个规范 URL 只展示一个最高分频道。
- 错过整段晨间窗口不补跑；白天小时刷新独立进行。下次成功查询扩大回看窗口，但超过 14 天仍可能漏报。
- D1 `weekdays_json` 使用周日 `0` 至周六 `6`。修改查询文本不会把已有 URL 重新评分。画像规则通过 D1 SQL / 迁移维护，无公开编辑入口。

## 评分画像与确定性策略

固定画像在 `src/llm/editorial-profile.ts`，不包含家人姓名、职业和未确认性格推测。技术、数码、任天堂、单机游戏、足球均有独立兴趣价值，采集频率不影响重要性判断。

策略版本 2：每条候选只请求一个 **Noul** 问题 `worthReading`：

> Given the owner's full editorial profile, is this news worth their time to read?

输入是完整固定画像、新闻标题/摘要/链接/日期，以及近期弱反馈。不发送频道名称、规则或优先级作为评估约束；任何领域都按主人整体兴趣判断。问题不附加评分档位或分项门槛，结果是“值得阅读”这一判断成立的概率，而不是相关程度、新闻质量或事实可信度。

严格校验 `[0,1]` 概率后，仅为兼容现有字段存储 `score = 100 × worthReading`，保留精度用于排序。**不再加权，不设 70 分线，不设相关性/质量/排除阈值**；所有有效响应均进入候选排序池，数据库沿用 `accepted` 状态表示可参与排序，并不意味着已被日报编辑选中。日报按新鲜度优先、同窗口内按分数排序，最多 10 条进入主模型二次筛选；白天每轮只展示前 3 条。非法响应、超时和请求失败仍拒绝，不编造分数。

旧版四维 Noul 加权策略和判定结果仅作为历史记录保留，不自动重评、不重新解释旧分数、不改写已发布日报。新判断在 `evaluation_json` 中记录 `version:2`、原始 `worthReading` 与反馈版本。

## 中文日报与历史档案

迁移 `0008_digests_feedback.sql` 增加日报、输入快照、引用来源和私人反馈表；`0009_rolling_news.sql` 增加小时搜索的候选成员关系。默认 `DIGEST_ENABLED=false`，必须明确选择 `DIGEST_MODEL` 才能启用。

- 默认北京时间 **09:00–10:00** 的第一个可用 Cron 生成当天一期；`DIGEST_HOUR` 可调整。采集与 Jev 先运行，日报独立处理，即使采集失败也不会删除此前日报。
- 普通日报以生成时刻为截止，优先读取最近 **24 小时**发布且有有效 Jev 判断的候选；允许 **24–48 小时**内的重要漏报作为补录，超过 48 小时、无有效日期或晚于截止时间的内容不进入输入。采集回看窗口不变，不按自然日切分。
- 同 URL 跨频道取最高排序值；先选最近 24 小时，再选补录窗口，各窗口内按分数降序、发布日期降序、ID 升序，合计最多 10 条，不分频道名额，不足不凑数。补录由主模型从严筛选，仅保留重要具体进展，不能用旧闻填充；引用补录来源的事件标题由程序强制加“【补录】”，来源展示发布时间及补录标记。重要性和跨 URL 同事件去重仍依赖编辑模型，不是确定性保证。
- 截稿时仍有未完成评估的候选会标注；未进入本次输入的候选只有仍在新鲜度窗口内才可进入下一期。已发布日报不回写。受信 CLI 的当天补发/空刊恢复仍保留独立的当天限制，不扩大其授权范围。
- 主模型二次筛选、合并同事件，生成一篇 200–300 字的中文正文和 0–10 个事件来源索引，不生成逐条长摘要。字数按去除空白后的 Unicode 字符数计（含标点，不含独立标题和来源列表）；有事件时严格校验最终正文上下限。若模型原稿为 190–199 字，仅追加固定提示“以上仅据摘要整理，请核对原文。”，不新增新闻事实、不调用模型重写；其余非法输出不发布、不自动付费重试。
- 每个事件引用 1–10 个本次提供的文章 ID，来源 ID 必须存在且不能跨事件重复。链接来自 D1，不采用模型生成的 URL。弱内容可全部省略；无入选事件时允许较短的真实空简报，不为了字数编造新闻。
- 提供最近 7 期中最多 16 条事件简述作为防重复参考；同一事件有实质新进展仍可报道。不能保证跨天语义识别准确，不是事实核验。
- 当天最多一次生成尝试，月请求默认上限 31，失败、超时或崩溃计入且不自动重试。输出非法不发布，上一期保持可访问。没有新候选时直接留档一份明确的空简报，不调用主模型、不占模型请求预算。
- 日报正文、引用的标题/摘要/日期/链接、画像与输入快照一并保存。已发布正文不随原文或画像变化重写；白天更新只进入实时列表。当前不提供公开改稿或重生成入口。
- 已进入成功编辑输入的原 URL（包括编辑舍弃的条目）不会原样再次送入日报；失败输入不标记已处理。新 URL 的相关后续仍会经模型检查，未进入本次 10 条输入的候选在 48 小时窗口内可留到后续期。
- `/daily` 为历史列表，`/daily/YYYY-MM-DD` 为永久阅读地址；`GET /api/digests` 每页最多 31 期，使用 `before` 日期向前翻页；`GET /api/digests/latest` 和 `/api/digests/YYYY-MM-DD` 只返回发布内容，不返回私人画像、输入或原始输出。

日报只根据搜索摘要成文，不读取全文。中文翻译、事件合并和事实陈述仍可能出错，必须保留原文便于核对。历史留档暂不自动删除，后续保留策略需要同时考虑 D1 容量和引用快照。

### 受控补发当天首期

仅运维可在 `wrangler.jsonc` 临时设置 `MANUAL_ISSUE_DAY=YYYY-MM-DD` 并部署，由下一次原有 Cron 执行（不修改 Cron，不开放 HTTP 管理接口）。必须是当前用户时区日期，搜索/Jev/日报开关均须开启。

- `0010_manual_issues.sql` 保存初次预留历史；`0012_manual_authorizations.sql` 将其复制到 `site_manual_authorizations`，按日期和明确授权标识记录每次运维任务。默认授权为 `initial`；只有负责人重新明确授权后，才能设置新的 `MANUAL_ISSUE_AUTHORIZATION` 标识续跑，不能自动更换标识重试。原始失败审计、已收费搜索和失败候选均不重置；日报仍保留每天一次生成预留。运行中后续 Cron 不重叠执行。
- 使用真实当前时间和通常的日/月预算及搜索、评估、日报预留键；今日应采查询全部完成、队列清空后才生成一期。搜索只取当天明确日期的新内容，允许本次授权将当天已有首次查询基线送去评估，不引入此前历史。
- 失败立即停止，不清除预算或失败记录；查看 `site_manual_authorizations`、`site_attempts` 和 `site_candidates` 诊断。日报失败另有 `site_digest_attempts.diagnostic_json` 保存脱敏错误及输出片段。中断的任务保持 running，须人工确认而非自动重试。
- 执行结束后移除 `MANUAL_ISSUE_DAY`、`MANUAL_ISSUE_AUTHORIZATION`（以及下述 `MANUAL_ISSUE_REGENERATE`，若有）并重新部署。普通排期不变；正常采集也已采用重叠窗口，不再把首次查询结果一律作为基线。不要为重试而删除任务记录或变造日期。

策略升级后，若负责人明确要求重新生成**当天已发布、没有主模型调用和处理输入的空简报**，可同时设置 `MANUAL_ISSUE_REGENERATE=true` 和新的明确授权标识。此专用流程不搜索，只重评当天已保存、尚无 v2 预留的旧策略候选；旧判断归档至 `site_judgment_history`，旧收费记录不改，v2 判断使用独立预留键。已有 v2 失败预留不自动重试。

重新生成的主模型请求先在 `site_digest_regenerations` 预留，与普通日报共享月预算。新输出校验成功后，同一 D1 事务将旧空简报和原 attempt 归档至 `site_digest_revisions`，再替换当前公开快照。失败保留旧页面，不自动重试。不能用此流程覆盖已有主模型正文的日报；不提供公网重生成接口。

若只需使用已有 v2 判断生成正文，设置 `MANUAL_ISSUE_REUSE_JUDGMENTS=true`，不会调用搜索或 Jev。若主模型已返回并保存草稿，只因本地校验失败，可在新的明确授权下设置 `MANUAL_ISSUE_REPLAY_DRAFT_FROM=原授权标识`：仅加载同日同模型的已保存输出，再做相同的确定性提示补充和严格校验，绝不再次调用模型。该本地发布记录 `model=none`、`providerCall=false`，不占额外模型预算；原失败记录保留，公开日报仍标记原作者模型。操作完成后移除上述临时变量。

## 私人反馈与评分参考

新闻列表及日报每条原文可反馈：**想多看这类 / 不感兴趣 / 已知或重复 / 质量差**，附最多 500 字说明，支持撤销。反馈不是公开评论，也不触发搜索、生成或重评。

- 每个用户、文章、频道保存当前反馈及递增版本；变更有不可覆盖的事件记录，请求 ID 防重，并发旧版本返回 409。每用户滚动 24 小时最多 100 次变更。
- 后续 Jev 仅接收同频道近 90 天的最多 6 条有效反馈，连同标题、原因和时间；邮箱、身份哈希和请求凭证不发送给模型。说明文字属于不可信偏好数据，不是工具指令。
- 明确画像和频道规则优先。单次负反馈不永久封禁主题；重复不等于不感兴趣，质量差不等于无关；未反馈不视为负反馈。
- 判断记录保留所用反馈版本与引用，撤销仅影响之后读取反馈的新评估；已在途的模型请求和历史判断不会撤回或重写。不会自动修改主题权重或搜索排期。

### 配置 Cloudflare Access

公开读页面仍不需要 `ADMIN_TOKEN`。反馈是唯一写入口，未配置以下内容时保持关闭：

1. 在自定义域名创建 Access Self-hosted 应用，**保护 `你的域名/api/feedback*`**，包括 login/session 路由，只允许你的邮箱。不要配置 Bypass，也不要允许任意用户；在生产上逐一验证路径规则。
2. 将 Team 域名（如 `team.cloudflareaccess.com`）和该应用的 Audience Tag 写入 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。
3. 设置 `FEEDBACK_ALLOWED_EMAILS` secret（逗号分隔的明确邮箱白名单）：`npx wrangler secret put FEEDBACK_ALLOWED_EMAILS`，再开启 `FEEDBACK_ENABLED=true`。
4. 页面“登录反馈”会跳到同一受保护路径 `/api/feedback/login`，登录并通过 Worker 验证后返回 `/feedback`；页面外壳本身仍可公开访问。浏览器使用 Access 会话 cookie，不在 JS/URL/localStorage 保存管理凭证。

Worker 自行验证 Access JWT 的 RS256 签名、固定 Team JWKS、issuer、audience、有效期和邮箱白名单，**不信任单独的邮箱请求头**。API 私人响应 `no-store`，POST 要求同源 Origin、JSON 且限 4 KB，无 CORS。JWT/JWKS 验证失败时拒绝写入。使用可信设备；Access 的登录和退出由 Cloudflare 管理。

## 本地验证

要求 Node.js 22+（推荐 24）：

```sh
npm ci --include=dev
npm run check
npm run build  # dry-run，不部署
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run dev
```

默认搜索、Jev、日报和反馈都关闭，无需真实凭证即可查看空页面。**AI binding 是远程资源**；本地开启 `JEV_ENABLED=true` 或 `DIGEST_ENABLED=true` 并正确配置 Gateway 后，会产生真实推理调用。不要把本地开发当成天然离线环境。测试全部 mock 外部调用。

## 首次 Cloudflare 部署（需手动）

1. 创建 D1：`npx wrangler d1 create get-news`，将返回的真实 `database_id` 填入 `wrangler.jsonc`。当前账户已创建同名数据库并完成至 `0013` 的迁移，ID 已填入配置；本账户后续部署复用它，不重复创建。迁往其他账户时需替换该 ID。
2. 创建同账户 AI Gateway。按 Cloudflare 当前要求配置 Jev 的模型访问与 Unified Billing/账户余额，并检查网关限流、自动重试和模型回退策略。**本项目不自动重试，网关也应关闭自动重试和付费回退**。
3. 将 `AI_GATEWAY_ID` 改为真实 Gateway ID；保留 `ai.binding = AI`，不需要在 Worker 保存 Cloudflare REST API Token。
4. 应用迁移（已有数据先备份）：
   ```sh
   npx wrangler d1 migrations apply get-news --remote
   ```
5. 配置搜索 secret：
   ```sh
   npx wrangler secret put TAVILY_API_KEY
   ```
6. 保持 `SEARCH_ENABLED=false`、`JEV_ENABLED=false`、`DIGEST_ENABLED=false`、`FEEDBACK_ENABLED=false`，由负责人执行 `npm run deploy`。访问 `/`、`/health` 和 `/api/news`，验证数据库迁移和只读页面。
7. 审核兴趣和费用授权后，在 `wrangler.jsonc` 中设置相应开关为 `true` 并重新部署。启用搜索会发送查询词给 Tavily；启用 Jev 会把新闻摘要、固定画像、频道规则和相关历史反馈交给模型服务。日报主模型也会收到新闻摘要、固定画像和历史事件简述。

生产配置应以版本控制中的 `wrangler.jsonc` 为准，避免后续 Git 构建覆盖 Dashboard 临时变量。`.dev.vars` 不会自动上传为生产 secrets。

### Cloudflare 拉取 Git 自动部署

首次资源、迁移和 secret 配好后，在 Workers Builds 连接 GitHub 仓库，选择 `main`：

- 安装：确保包含 devDependencies，例如 `npm ci --include=dev`。
- 构建命令：`npm run check && npm run build`。
- 部署命令：`npx wrangler deploy`。
- 构建环境使用 Node.js 24（测试使用 `node:sqlite`）。

之后推送会自动部署，**不要在首次授权前接通带收费开关的自动部署**。Git 部署不自动应用 D1 迁移，新增迁移仍需负责人先执行。仓库 GitHub Actions 仅验证，不部署。

### 变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SEARCH_ENABLED` | `false` | 定时 Tavily 搜索 |
| `JEV_ENABLED` | `false` | Jev 评估队列 |
| `AI_GATEWAY_ID` | 占位值 | 同账户 Gateway |
| `NEWS_TIMEZONE` | `Asia/Shanghai` | 排期及日/月预算时区 |
| `NEWS_MORNING_HOUR` | `7` | 晨间起始小时，0–7，窗口 3 小时，避免与小时刷新重叠 |
| `TAVILY_DAILY_CREDITS` | `36` | 搜索日预算，允许设 0 |
| `TAVILY_MONTHLY_CREDITS` | `950` | 搜索月预算，代码硬上限 1000 |
| `JEV_DAILY_REQUESTS` | `360` | Jev 日请求上限，覆盖新增候选的处理空间 |
| `JEV_MONTHLY_REQUESTS` | `10000` | Jev 月请求上限，不等于金额预算 |
| `TAVILY_API_KEY` | secret | Tavily 凭证 |
| `DIGEST_ENABLED` | `false` | 日报生成开关 |
| `DIGEST_MODEL` | 空 | 必须明确设置兼容的 `provider/model`、`@cf/author/model` 或 `dynamic/route`；生产已选择 DeepSeek V4.1 Flash |
| `DIGEST_HOUR` | `9` | 每天一期的生成小时，使用用户时区 |
| `DIGEST_MONTHLY_REQUESTS` | `31` | 主模型月尝试上限，0–31 |
| `FEEDBACK_ENABLED` | `false` | 本人反馈写入开关 |
| `ACCESS_TEAM_DOMAIN` | 空 | 固定 Team 域名，不能是任意 JWKS URL |
| `ACCESS_AUD` | 空 | 反馈路径的 Access 应用 Audience Tag |
| `FEEDBACK_ALLOWED_EMAILS` | secret | 反馈账号邮箱白名单 |

主模型使用同一 `AI` binding 与 Gateway，需配置该模型的计费或可用供应商凭证。仅支持 OpenAI chat-completions 格式响应，非流式、`temperature:0`、最多 4096 输出 tokens，不保证所有供应商参数兼容。生产 `@cf/deepseek-ai/deepseek-v4.1-flash-1017` 已查询实时 schema 并真实验收，使用 `max_completion_tokens`、`reasoning_effort:none`、JSON object 模式；其他兼容模型沿用 `max_tokens`。没有默认收费模型，启用前须明确模型和费用授权。

## 可靠性、安全与运维

- 搜索与模型请求前 D1 原子预留预算，失败、超时和崩溃不退回。次数限制不等于金额限制，请同时设置供应商账户费用上限。Tavily 免费额度为账号共享，其他项目不在本地账本内。
- Jev 单次 15 秒，主模型传输上限 30 秒；超时后远端可能仍完成并计费，不自动重发。绑定不提供这里可用的远端取消保证。
- 新闻与日报公开只读；唯一写入口是 Access 认证的反馈，无 `ADMIN_TOKEN`、无公开管理操作、无 CORS。`/health` 只证明 HTTP 入口响应。
- 来源 URL 使用公共 HTTPS 检查，拒绝重定向；Tavily 响应限 1 MB。正文按纯文本渲染，严格 CSP，无第三方 CDN。
- 只发布明确投影的新闻字段，不发布画像、查询、原始模型输出、预算或错误详情。新闻页面是公开的；需要私密阅读时应另加 Cloudflare Access，而不是管理 Token。
- Jev 与日报 Gateway 请求均设置 `collectLog:true`、`skipCache:true`。Gateway 可能保留新闻、画像及反馈输入和模型输出，请按本人需求管理网关访问权限与保留期。Worker 同时记录脱敏后的原始错误名称、消息、错误码、状态码和请求 ID（若上游提供）；Jev 错误另存私有 `site_attempts.diagnostic_json`，不暴露给公开 API。
- 最小 Jev 验证：应用迁移 `0011_model_diagnostics.sql` 后，临时配置 `JEV_SMOKE_TEST_ID=当前本地日期:唯一测试标识` 并部署。下一次原有 Cron 只发送一个合成状态、一个 Noul 问题；调用前预留通常的 Jev 日/月预算，结果或脱敏异常保存在 `site_attempts`。同一标识不重复执行，失败/超时不自动重试。不需要开启搜索/Jev 队列/日报开关，不读取画像或真实新闻。测试结束移除此临时变量并部署。
- Tavily 认证/配置/额度错误会暂停搜索，需修复后用受信 SQL 清除 `site_provider_state` 对应行；429/暂时错误至少暂停 30 分钟。异常 basic 消耗超过 1 credit 会按报告记账并暂停，待人工排查。
- 失败不覆盖已有入选内容；运维查 `site_runs`、`site_attempts`、`site_candidates`、`site_provider_state` 和 `site_digest_attempts`。不通过公开接口暴露完整运行日志。
- 尚未自动清理历史记录，长期运行需要制定保留策略并监控 D1；不承诺全量新闻覆盖、准确的语义去重或事实核验。

官方接口依据：[Jev](https://developers.cloudflare.com/ai/models/typesafe/jev-1.14.0/)、[AI binding / Gateway](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。适配器已通过 mock 测试，尚未经真实付费调用验收。
