# OpenClaw 微信插件到 Codex 的改造报告

分析对象：

- `@tencent-weixin/openclaw-weixin-cli@2.1.4`
- `@tencent-weixin/openclaw-weixin@2.4.6`
- `@openai/codex-sdk@0.148.0`

## 结论

CLI 包只是 OpenClaw 安装器，真正的微信实现位于
`@tencent-weixin/openclaw-weixin`。真正插件以 MIT 许可证发布源码，且运行时 npm
依赖只有 `zod` 和 `qrcode-terminal`；OpenClaw 是 peer dependency。因此协议层可以
合法、技术上也可以独立移植。

## 绑定点分类

可直接复用：

- `src/api/*`：iLink HTTP API、long-poll、typing、start/stop 通知。
- `src/cdn/*`：AES-128-ECB、上传、下载与媒体解密。
- `src/media/*`：图片、视频、文件、SILK 语音处理。
- `src/messaging/markdown-filter.ts` 与大部分 `send.ts`。
- 扫码状态机和二维码显示。

需要适配：

- `auth/accounts.ts`：从 OpenClaw state/config 改为网关自己的账号目录。
- `util/logger.ts`：从 OpenClaw 主日志改为独立 JSONL 日志。
- `monitor/monitor.ts`：把 `channelRuntime` 改成显式 `onMessage` 回调。
- `messaging/inbound.ts`、`storage/sync-buf.ts`：状态目录迁移。
- `messaging/send.ts`：移除仅用于类型的 `ReplyPayload` 引用。

必须重写：

- `index.ts` 与 `channel.ts` 的 `api.registerChannel` 注册层。
- `process-message.ts` 中的 OpenClaw routing/session/reply dispatcher。
- OpenClaw command authorization 与全局 hook runner。
- OpenClaw 配置热加载触发逻辑。

## 新的运行时映射

| OpenClaw 能力 | 独立网关实现 |
|---|---|
| `ChannelPlugin.gateway.startAccount/stopAccount` | `WeixinCodexGateway.start/stop` |
| `resolveAgentRoute` | `accountId:userId` conversation key |
| `recordInboundSession` | `threads.json` 持久化 Codex thread ID |
| `dispatchReplyFromConfig` | 常驻 `CodexAppServerBackend.respond`（SDK 可回退） |
| channel status | `/healthz`、`/readyz`、`/status` |
| sync cursor | `delivery-state.json` 中与收件箱批次原子提交；旧 sync 文件作为兼容镜像 |
| channel logs | `stateDir/logs/*.jsonl` |
| retry/runtime queue | 持久收件箱、会话 FIFO、命令快车道、ledger、pending reply、dead letter |

## 已完成的生产验证

- 已用真实微信账号完成扫码、凭证持久化、重启免扫码和文本收发。
- 已验证本地命令快车道；`/settings` 的真实端到端耗时为 411ms。
- 已用本机 Codex App Server 0.148.0 验证初始化、同一 PID 多 turn、事件流、真实模型 turn
  和进程重启后的 `thread/resume`。
- 已验证模型、推理强度和服务等级按会话持久化，并在入队时冻结，避免同批消息时序串扰。
- 已验证 64 位微信消息 ID 不经 JavaScript 浮点数舍入，以及游标/收件箱的原子提交。
- 已验证 App Server `imageGeneration` 产物自动上传微信 CDN 并作为图片消息回传；图片
  使用稳定 `client_id` 和独立持久发送进度。

## 后续可扩展项

- 新队列链路仍应继续做图片、文件、语音的大样本真实账号回归。
- 任意工具生成的普通文件与视频自动识别、回传可作为下一阶段增加。
