# 生产验收状态（2026-11-11）

- 地址：https://get-news.fzt-tom.workers.dev
- D1：`get-news`，迁移已应用至 `0013_digest_regenerations.sql`。
- Gateway：`cf-gateway`；日报模型：`@cf/deepseek-ai/deepseek-v4.1-flash-1017`。
- 当前本地与线上开关一致：SEARCH/JEV/DIGEST 为 true，FEEDBACK 为 false。单次 Noul 策略及 DeepSeek V4.1 Flash 均已真实验收，日志开启，全部临时任务变量已移除。`TAVILY_API_KEY` 已保存在生产 Secret 中。
- 一次性补发配置 `MANUAL_ISSUE_DAY` 已移除，普通 Cron 仍为每 10 分钟。

## 首次真实任务

北京时间 11:50，通过原有 Cron 执行当天唯一预留任务。

- Tavily 成功 6 次，账本记 6 credits。
- Jev 预留并尝试 1 次，约 4.2 秒后失败，不是本地 15 秒超时。
- 候选状态：7 baseline、1 failed、9 pending；未发布任何入选内容。
- 没有调用日报主模型，没有生成或发布今天的日报。
- `site_manual_issues.day='2026-11-11'` 为 failed；不删除该记录、不重置失败候选或预算以自动重试。

首次错误未保存具体响应，不能直接确定其上游原因。Wrangler OAuth 调用 AI Gateway 管理/日志 API 返回 403（管理权限不足，**不代表推理返回 403**）。下述最小测试已确认 Jev 本身可调用，并定位了适配器的返回结构缺陷；不应再据此前信息要求用户检查模型名或计费。

## 12:10 开启日志后的单次最小测试

- Jev 与日报 `collectLog:true`；具体脱敏异常同时保留在 Worker 日志，Jev 另保存至私有 D1 字段 `diagnostic_json`。
- 唯一标识：`jev-smoke:2026-11-11:logging-01`。预留一次 Jev 预算，实际只发送一个合成状态和一个 Noul 问题，不发送画像，不搜索或生成日报。
- **上游调用成功**，约 3 秒返回：`{"state":"Completed","result":{"model":"jev-1.14.0","answers":{"matches":{"type":"noul","noul":0.99}},"usage":{"input_tokens":282,"output_tokens":20}}}`。
- 旧适配器直接读取顶层 answers，错误地将该成功响应记为 failed。此历史审计保持不变，完整合成响应已保存于 diagnostic_json。
- 已修复 Jev、日报 chat 及最小测试的 completed-result 解包，同时兼容原生 JSON；非 Completed 或非法结果仍拒绝。
- 使用保存的响应离线回放并补回归测试，**没有再发第二次真实请求**。测试临时变量已移除；当时搜索和日报仍暂停，随后收到正式运行授权。

## 12:30 明确授权后的正式首期

- 新授权 `operator-resume-01` 在 `site_manual_authorizations` 中记录为 completed；原 `initial` 失败审计保留。复用全部已成功搜索，不重发失败候选。
- 全日晨间计划共 14 次 Tavily 搜索（复用 6、新增 8），账本记 14 credits。
- 成功评分 9 条，全部 rejected，最高 53 分，未达到现有相关性/质量等门槛。历史 1 条失败候选不重试；29 条无当天合格日期等结果留在 baseline。
- 已发布 https://get-news.fzt-tom.workers.dev/daily/2026-11-11 ，公开 API 和页面均返回 200。这是明确的空简报，正文不是 200–300 字新闻总结；无入选候选时不凑数。
- 主模型调用次数为 0，日报 attempt.model 为 none；`deepseek/deepseek-flash` 仍未经真实调用验收，不能宣称整条主模型链路验证完成。
- 一次性日期和授权变量已移除并重新部署。正常采集、评分及日报开关保持开启，反馈关闭，本地与线上配置一致。

## 13:30 单次 Noul 新策略部署及明确授权重生成

- `worthReading` 单一 Noul 已部署，无加权或分数阈值。359 个离线测试通过。
- 授权 `noul-v2-regenerate-01` 只复用已有新闻，新增搜索为 0。10 条旧判断在 `site_judgment_history` 留档，v2 独立预留，10 次重评全部成功。
- 最高：Railway AI Key 失窃报道 `worthReading=0.78`；Xbox 掌机超分辨率更新 `0.76`。全部 10 条进入主模型输入，无分数门槛。
- 第一次真实主模型调用使用用户现有配置 `deepseek/deepseek-flash`，返回 `AiGatewayError: 7003: User Input Error`。错误已存入 `site_digest_regenerations.diagnostic_json`，未自动重试。
- 随后只读目录校验：`wrangler ai models schema deepseek/deepseek-flash` 返回 `6002 Model schema not found`；模型列表没有该 ID，列有 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`（输入 $0.30/百万 tokens，输出 $1.20/百万 tokens）。未擅自切换或再次付费调用；原生 @cf 模型需对应的适配支持。
- 旧空简报未被替换，原每日免费 attempt 保留；主模型重生成 attempt 记录 failed，并计入月请求预算。
- 一次性配置已移除，仅将 DIGEST_ENABLED 设为 false 暂停日报，SEARCH/JEV 继续 true。等待负责人确认正确主模型及新的生成授权；无需再重评已完成的 v2 候选。

## 13:40–13:50 切换已确认存在的 Workers AI DeepSeek Flash 并发布

- 负责人明确授权切换 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`。上线前通过 `wrangler ai models schema` 核实输入/输出，使用 `max_completion_tokens:4096`、`reasoning_effort:none`、JSON object 模式，仍走 `cf-gateway`。
- `cf-flash-summary-01` 只复用 v2 判断，没有新的搜索或 Jev 调用。主模型真实调用 1 次并成功返回 4 个事件及来源；原稿正文去空白后 195 字，最初因字数下限记为校验失败，原始输出完整保留。
- 不为字数重新付费调用模型。补上固定来源提示“以上仅据摘要整理，请核对原文。”，不新增事实，再严格校验并在 `publish-saved-flash-01` 授权下本地发布。
- 此本地发布记录 `model=none`、`providerCall=false`，指不含额外推理请求；`authoredByModel` 与公开日报正确记录实际 DeepSeek 模型。原调用/失败审计保留。
- 新日报正文 210 字（含来源核对提示）、4 个事件、4 个原文引用；原空简报和原 attempt 已在 `site_digest_revisions` 归档。公开 API 与日期页面均实测 200。
- 本轮无新增搜索、无新增 Jev 调用；本阶段合计只调用新主模型 1 次。
- 362 个离线测试通过，类型检查、dry-run 构建通过；已部署并移除全部临时变量，常规采集/评分/日报继续开启，反馈关闭。

当前日报：https://get-news.fzt-tom.workers.dev/daily/2026-11-11

调试远程开发代理/预览时失败在数据库预检，未触发搜索或模型调用。临时预览代码、配置已删除，生产无 HTTP 管理入口。
