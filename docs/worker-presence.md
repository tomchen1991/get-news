# Worker 内热点 agent 的人物状态上报

## 对象与纠错

上报对象是 **Cloudflare Worker 内执行热点采集/评估/日报任务的 agent**，不是开发本项目的 PI。此前提交 `f0f7829` 误记为 PI 接入，仅添加了文档；随后重新部署原 Worker，并未实现 Worker 上报。此前的 PI 合成验收不构成 Worker 的上线证明。错误文档已移除。

实际实现位于 `src/site/worker-presence.ts`，由 `src/site/index.ts` 的 `scheduled()` 调用，覆盖普通定时任务、受控手动任务和 smoke 调度。HTTP 浏览/health 不触发上报。

## 真实生命周期

Worker 是按次唤醒的无常驻进程任务，不能借用 PI 人物或凭空保证全天在线：

- 每次 scheduled invocation 新建随机 `instance_id`，在本次调用内保持不变，`state_seq` 从 1 递增。不共享 isolate 全局 ID，不冒充跨重启同一进程。
- 开始为 `working`，任务运行期间每 15 秒发送新的完整观察，结束为 `stopping`；异常只用固定阶段词，不传异常内容。
- 全程只有一个在途请求。终态等待前一请求完成或超时后再发，不让本端旧 working 在 stopping 后发送。
- 调用结束就停止心跳、清理定时器；进程被终止时不保证末次送达，由采集端失鲜/过期规则处理。
- 当前 Cron 每 10 分钟唤醒。因此**两次执行之间可能显示停止、失鲜或消失**，不能当成常驻 idle 人物。若要求一直在办公室在线，需要另行设计常驻协调器和展示语义，不能单靠改人物名称或把 Cron 加密来伪造在线。
- 并发调用是不同运行实例，不把它们混成一个共享人物。专属桌/稳定业务角色的展示绑定属于消费侧契约，单靠 `member_name` 不保证自动分桌。

## 契约与隐私

发送到固定配置的 `POST /ingest/agent_presence/1`，信封为 `{sourceId,data}`，不是 batch 或新闻事件接口。

固定成员名为 `热点获取 Agent（Worker）`，任务类别 `scheduled_task`，任务范围 `热点采集与日报`，repo 为 `get-news`。`provider/model` 为 null，不冒称 SDK 当前 PI 模型或某次实际调用模型。

不发送新闻标题、链接、原文、画像、反馈、提示词、用户消息、工具输出、原始异常、完整路径或密钥。正文与准确 Content-Length 均由本端生成；响应限制 8KiB，单次超时 4 秒，不跟随重定向，仅允许无用户名/密码、无 query/fragment 的公共 HTTPS 固定路径。

200 回执须验证 version、memory persistence、processId、时间、source/instance、result 与序号。accepted 仅代表采集端内存接受，不是持久提交或用户已看到。

## 故障隔离

默认关闭。配置无效、网络/采集失败均不阻断新闻任务，也不改变新闻判断。日志只有固定错误码，不打印凭据或响应正文。

不自动重放任何失败/不明结果的旧快照，无磁盘/D1 outbox；后续心跳只发送新观察和新序号。401/403/409/410 等明确拒绝、重定向、无效 ACK 停止本次调用发送。429 尊重数字/日期 Retry-After，退避期间也不抢发终态。任务异常原样保留给原调用者。

这只是人物元数据，不是用户新闻提醒；不接触现有通知额度、D1 alert 预留或 webhook 重试策略。

## 启用前提

运维须为 **Worker 单独配置** sourceId 和有 `agent_presence` 写权限的高熵 producer token，不复用 PI/主 Agent/consumer 凭据：

```ini
WORKER_PRESENCE_ENABLED=true
WORKER_PRESENCE_URL=https://YOUR-COLLECT-HOST/ingest/agent_presence/1
WORKER_PRESENCE_SOURCE_ID=ADMIN_ASSIGNED_WORKER_SOURCE
```

`WORKER_PRESENCE_TOKEN` 用 Wrangler secret 私密配置，不写入 Git、聊天或命令行参数。示例文件默认 false，不提供默认 endpoint/source/token；缺任何一项不会发送。

当前仅完成 mock Worker 测试；没有为该 Worker 提供或设置真实 producer 配置，没有取得 Worker 的真实接收回执。本轮修正不应被称为已接通生产。此前 PI 人物已到展示端的证据与此 Worker agent 无关。
