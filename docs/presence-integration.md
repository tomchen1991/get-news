# 热点获取 agent 的人物状态上报

## 对象与边界

上报对象是运行本项目的 **DeckZ 协作 PI 人物**，不是新闻内容，也不是 Cloudflare Cron。复用宿主已有 `pi-monitor`；不向 Worker 添加 HTTP 上报、定时心跳、D1 delivery 表或 producer 凭据，不增加模型调用。

本次未部署、未改宿主私密配置、未重启进程，也未发起生产/公网联调。早期误作热点事件上报的未接线草稿已全部撤回。

## 当前接线

```text
DeckZ 协作 PI（SDK 生命周期与协作 metadata）
  → 私有本机 Unix socket
  → macOS 统一 pi-presence-monitor
  → POST /ingest/agent_presence/batch/1
  → 采集服务内存人物状态
```

- 当前启动环境为 `PI_MONITOR_ENABLED=1`、`PI_MONITOR_ROLE=collaboration`，存在 `PI_PRESENCE_SOCKET`，socket 权限为 0600。
- 只读检查进程文件描述符，确认当前 PI 的 Unix socket peer 对应运行中的统一 monitor socket。此结论仅针对检查时的当前进程；重建会话需重新检查。
- **本机已连接不代表采集服务已接收**。本次没有读取真实 producer token，也没有查询生产状态或取得真实远端 ACK。
- socket 模式下 PI 不直接 POST、不读取 token；配置与 HTTPS 发送归宿主统一 monitor 所有。不能为此人物再启一条项目级上报链路。

## 字段与状态

宿主既有规则负责生成完整快照：

- `member_name`: `DeckZ 协作 PI`（来源类别，不是认证身份）。
- `task_name`: 当前会话已注册的协作组；离组/断连/无可信 metadata 时清空，不解析用户请求或新闻正文。
- `repo`: 可信 Git 工作树根目录 basename，本项目为 `get-news`；不上传路径/remote。
- `instance_id`: PI 进程实例随机 ID；进程内序号递增，reload/new 不伪造新人物。
- `status`: SDK 活动生命周期；不从回复文字猜状态，不把工具结束当整个人物空闲。
- `provider` / `model`: SDK 当前选定模型元数据，不额外调用模型或读取密钥。

只上传契约白名单字段，不含新闻、画像、反馈、提示词、工具参数/输出、日志或聊天正文。采集端以内存保留状态，不提供持久化 ACK。失鲜与过期由采集端处理，不能把曾连接当作一直在线。

## 固定契约与实现位置

宿主代码位于相邻的 `cocoon` 仓库，不在本项目内复制实现：

- `docs/AGENT_PRESENCE.md`
- `apps/pi-presence-monitor/README.md`
- `packages/pi-extensions/packages/pi-monitor/src/presence-monitor.ts`
- `packages/pi-extensions/packages/pi-monitor/schema/agent_presence.v1.json`
- `packages/pi-extensions/packages/pi-monitor/schema/agent_presence.batch.v1.json`

采集服务对应 `collect-service/collections/contracts/` 下同名文件。本次核对双方 SHA-256 一致：

```text
agent_presence.v1.json
b2fe43445df70a7ac0311f7df48d080c9c550ab6c41275961ce8786c76eb1340
agent_presence.batch.v1.json
6d1d59ad77c084ced9ea4c7520e346180e2751c9bd7988a5932446191f9c7cde
```

不要把单条 `/ingest/agent_presence/1` 用作 socket 模式统一 monitor 的批次入口，也不恢复旧 `/producer/events`。

## 验证与剩余验收

在宿主 `cocoon/packages/pi-extensions` 运行既有合成测试（mock HTTP / 临时本地 socket，不使用当前 monitor 的真实凭据）：

```sh
pnpm exec vitest run \
  packages/pi-monitor/test/presence-monitor.test.ts \
  packages/pi-monitor/test/batch-client.test.ts \
  packages/pi-monitor/test/local-presence.test.ts \
  packages/pi-monitor/test/local-launch.test.ts
```

结果：4 文件、20 项通过。最初从子包运行时被工作区 include 规则排除，调整到工作区根目录后上述命令通过，没有修改测试。

### 本地真实 HTTP 联调

已使用宿主现有编译产物 `LocalPresenceObserver → 临时 Unix socket → PresenceBatchMonitor → postBatch`，连接采集服务提供的临时 loopback fixture。仅使用合成身份与临时 producer 凭据；凭据只在进程内读取，不记录到本文或终端。该 fixture 使用真实 Studio HTTP/auth/cache，但 DB backend 为拒绝调用的替身，不代表完整 PG/CLI 环境。

合成 source 为 `get-news-dev`，instance 为 `fbc74362-956e-4051-8d35-c86d9ba6e98e`。所有响应均通过宿主 `parseBatchAck`，并逐项断言身份、结果和水位，而非仅检查 HTTP 200：

| 输入 | 逐项结果 | 当前水位 |
| --- | --- | --- |
| working，seq 2 | accepted | 2 |
| idle，seq 3 | accepted | 3 |
| stopping，seq 4 | accepted | 4 |
| 原样重复 stopping，seq 4 | duplicate | 4 |
| 旧 working，seq 2 | outdated | 4 |
| 尝试恢复 working，seq 5 | rejected / conflict | 4 |

初始本地观察被合并，首次 HTTP 接受 seq 为 2；序号允许有空缺，不编造 seq 1 已接收。后三项为显式合成验收请求，不是自动重试策略。

观察者和隔离 monitor 已关闭，临时 socket 已删除；已通知采集服务核读实例/历史后关闭 fixture、清理临时凭据。服务端独立读回与 fixture 关闭须由对方确认，不能仅凭发送方断言已完成。

本次不修改当前人物的宿主配置、不向当前真实 monitor 注入合成人物。真实人物在本机统一 monitor 上已连接，与本次合成 source 是两件事；不将本地验收冒充真实人物远端接收或生产接入成功。
