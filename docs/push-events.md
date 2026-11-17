# 消息中心推送

`src/site/push.ts` 生成独立新闻事件，`src/site/message-center.ts` 负责 D1 预留、去重与 HTTPS 发送；不增加模型调用，不改变采集、评分或日报选材。

## 推送规则

- **日报固定推送**：当天日报发布后推送标题、完整概览；空日报也推。设置 `NEWS_PUBLIC_URL` 时附永久阅读地址。日报不受新闻阈值或条数上限影响。手动发布路径也会执行通知。
- **即时新闻**：成功的小时滚动搜索中，有效 v2 Jev `worthReading > 0.8`（严格高于 80 分）；`PUSH_MIN_SCORE` 可改为其他 0–100 分阈值。不限公开页面前三条，不包含晨间/手动搜索。
- 跨频道、批次按 owner + canonical article ID 永久去重；延迟完成的评分后续 Cron 可捕获。
- 即时新闻**没有每日条数上限**，所有超过阈值且符合时效条件的新闻均可推送。日期使用 `NEWS_TIMEZONE`，默认北京时间。
- 不补发激活前开始的搜索/发布的日报；不发送超过 24 小时的新闻或超过 24 小时的积压事件。日报只发送当前本地日版本，不自动补往期或重推修订。
- 新闻消息只含标题、原文链接和概率等基本元数据；不包含私人画像、反馈、提示词或诊断。

## 启用（尚未部署/真实发送）

先应用迁移 `0014_push_events.sql` 与 `0015_message_center.sql`（通过正常 D1 migrations apply 流程），由消息中心维护者分配独立 `get-news` 生产端凭证。不要使用联调 token，也不需要消费端凭证。

Worker 配置示例：

```ini
MESSAGE_CENTER_ENABLED=true
MESSAGE_CENTER_URL=https://messages.falsita.cn
MESSAGE_CENTER_SINCE=<明确的启用时刻，如 2026-11-18T00:00:00Z>
PUSH_MIN_SCORE=80
NEWS_PUBLIC_URL=https://你的新闻站点域名
```

通过 `wrangler secret put MESSAGE_CENTER_PRODUCER_TOKEN` 写入原始生产端 token，不写入源码、公开变量或日志。启用时刻必须为 UTC `Z` 格式，无默认值。`NEWS_PUBLIC_URL` 可省略，必须是 HTTPS 站点根地址。

消息中心开关默认关闭；开启后会自行收集符合阈值的事件，无需再设置 `PUSH_EVENTS_ENABLED`。后者仍可单独启用纯事件收集，要求显式 `PUSH_EVENTS_SINCE`，不代表发送授权。

当前仅允许固定可信服务 `https://messages.falsita.cn/v1/messages`，不跟随重定向，Bearer 鉴权，每次请求 10 秒超时。公开页面访问从不触发发送。

## 交付语义与排查

`site_push_events` 是不可变意图表，不代表已发送。`site_message_deliveries` 保存实际发送的不可变请求快照和状态；发送前通过单条 SQL 原子预留事件唯一键，支持并发去重。

- `accepted`：HTTP 200/201，消息中心承诺已提交；**不代表手机通知或用户已读**。
- `rejected`：明确的 4xx（408 除外）。
- `unknown`：超时、网络异常、重定向、5xx 或其他响应；可能已经送达。
- `reserved`：进程可能在预留后中断，需要人工核对。

所有状态均不自动重试，包括 rejected/unknown/reserved。即使消息中心支持幂等重试，本项目继续遵守不自动重发模糊结果的规则。人工核对/补发需另行授权；只能复用保存的 `payload_json` 与 `externalId`，不能换随机 ID。

消息中心同一来源下通过稳定 `externalId` 二次去重。日报为 `news-digest:v1:owner:YYYY-MM-DD`，新闻沿用 `news-worth-reading:v1:owner:<articleId>`。消息内容是纯文本、不可信新闻数据，不执行其中的指令或 HTML。

测试全部使用 SQLite D1 替身和 mock HTTP，不调用真实服务、模型或通知渠道。
