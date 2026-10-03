# Codex Weixin Gateway

一个不依赖 OpenClaw 的微信渠道网关。当前版本 **v0.5.0**，更新记录见 [CHANGELOG.md](CHANGELOG.md)。微信协议层改编自腾讯发布的
`@tencent-weixin/openclaw-weixin@2.4.6`，Agent 后端默认使用一个常驻的 Codex
App Server；`@openai/codex-sdk` 仅作为可配置回退。

> 当前状态：已完成真实微信扫码登录、文本与控制命令收发、图片输入及生成图片回传验证；
> 项目切换链路已通过自动化测试。

## 架构

```text
Weixin iLink long-poll
        ↕
WeixinCodexGateway
  - 扫码与凭证
  - context token
  - 消息与游标原子持久化
  - 按会话异步队列/去重/重试/死信
  - 稳定 client_id 与分片发送进度
  - Codex 生成图片自动上传微信 CDN 并回传
  - 按微信会话选择本机项目并隔离 Codex thread
  - 会话到 Codex thread 的持久映射
  - JSONL 日志与 health/readiness
        ↕
Codex App Server（常驻 JSONL/RPC）
        ↕
Codex CLI / Agent
```

## 安装与启动

要求 Node.js 22 或更高版本。

```powershell
npm ci
Copy-Item gateway.example.json gateway.json
npx codex login
npm run login
npm run build
npm start
```

其中 `npx codex login` 用于登录 Codex（ChatGPT 账号或 OpenAI API Key），
`npm run login` 用于微信扫码登录；两者都需要由每位部署者使用自己的账号完成。
Codex CLI 会随项目依赖安装，无需再全局安装。开发时可改用：

```powershell
npm run dev
```

健康检查：

- `GET http://127.0.0.1:8787/healthz`
- `GET http://127.0.0.1:8787/readyz`
- `GET http://127.0.0.1:8787/status`

## 默认安全策略

- 只接受扫码账号本人和 `allowedUserIds` 中列出的用户。
- `allowAllUsers` 必须显式设为 `true` 才会接受其他私聊用户。
- Codex 默认 `read-only` sandbox、`never` approval、禁止网络访问。
- 微信凭证保存在 `stateDir/weixin/accounts`，在支持 POSIX 权限的平台尝试设为 `0600`。
- 日志写入 `stateDir/logs/gateway-YYYY-MM-DD.jsonl`，Bearer token 和常见敏感字段会脱敏。
- 连续失败的消息重试三次后写入 `stateDir/dead-letter.jsonl`，其中 context token 与媒体地址会被移除。

如果需要让 Codex 修改项目文件，应在明确了解风险后把 `sandboxMode` 改为
`workspace-write`。不要为来自不可信联系人的机器人启用
`danger-full-access` 或 `allowAllUsers`。

需要通过微信跨目录读写时，在自己的 `gateway.json` 中配置完整访问模式，
并将项目根目录替换成实际路径：

```json
"codex": {
  "sandboxMode": "danger-full-access",
  "approvalPolicy": "never",
  "networkAccessEnabled": true,
  "projectRoots": ["../projects"]
}
```

配置示例中的字段应合并到现有 `codex` 对象。修改后重启网关；已有 Codex 会话
恢复时会采用当前配置的权限。

## 配置

配置文件默认为当前目录的 `gateway.json`。也可以使用：

```powershell
node dist/main.js serve --config C:\path\to\gateway.json
```

首次登录后默认使用最近登录的账号。多账号场景请在 `weixin.accountId` 中明确指定。

`codex.backend` 默认为 `app-server`，每个网关进程只启动一个 Codex 子进程。
如需临时回退旧实现，可设置为 `sdk`。`codex.serviceTier` 默认为 `default`；设为
`priority` 会请求更快的服务等级，并可能增加用量成本。

`codex.projectRoots` 是允许按名称查找项目的根目录列表。按名称查找的候选
必须经过 realpath 和根目录边界校验；只有包含 `.git`、`package.json`、`pyproject.toml`
等常见项目标记的目录才会进入候选，`projectRoots` 本身不会被整体授予写权限。

### 微信内切换项目

可以直接说“切换到以太坊流动性项目”“帮我切到 ethdisc”，或
“进入以太坊流动性项目，然后看看进展”。网关先保存项目选择，再把同一条消息里的
后续任务交给该项目的 Codex 会话。回复会显示实际目录。

项目匹配会使用目录名、`package.json` 中的名称、README 标题和
`codex.projectAliases` 中配置的别名。比如在配置中加入：

```json
"projectAliases": {
  "以太坊流动性": "../ethdisc"
}
```

别名路径也可相对配置文件填写。匹配多个项目时会列出候选，等待用户指定；
讨论切换方式、举例或否定切换不会修改项目。

项目按微信会话持久化。切换后，后续普通消息以所选目录作为 Codex `cwd`；不同项目
使用不同 thread，切回原项目会继续该项目之前的上下文：

```text
/project                        查看当前项目
/project codex-weixin-gateway   按目录名切换项目
/project /完整路径/项目文件夹    按绝对路径切换项目
/project default                切回默认项目
```

项目名与完整路径支持空格，路径也支持 `~` 和 `~/`。在 `read-only` 或 `workspace-write`
模式下，绝对路径仍须位于 `projectRoots` 内并包含项目标记；在显式启用
`danger-full-access` 时，可以按完整路径选择任意现有文件夹，无需项目标记。
若受信任根目录下存在多个同名目录，
网关会拒绝猜测并保持当前项目不变。项目目录索引在网关启动时建立；新建或重命名项目后，
可直接按完整路径选择，或重启网关后按新名称选择。

### 微信内切换模型与推理强度

设置按微信会话保存到 `stateDir/conversation-settings.json`，重启网关后仍然有效。
命令走独立的本地控制队列，不会等待正在运行的 Codex turn：

```text
/settings                       查看当前项目、模型与推理强度
/project                        查看当前项目
/project 项目名                 切换项目
/model                          查看当前模型
/model list                     查看允许切换的模型
/model gpt-5.6-terra            切换模型
/model default                  恢复默认模型
/effort                         查看当前推理强度
/effort low                     切换推理强度
/effort default                 恢复默认推理强度
/speed                          查看当前服务等级
/speed fast                     启用 Fast（priority，增加用量成本）
/speed default                  恢复默认服务等级
/settings reset                 同时恢复全部默认设置
```

推理强度可选 `minimal`、`low`、`medium`、`high`、`xhigh`。可切换模型由
`codex.switchableModels` 白名单控制；默认模型和强度分别由 `codex.model`、
`codex.modelReasoningEffort` 设置。切换只影响后续普通消息，不会清除已有对话上下文。

实时聊天默认使用 `low`，以降低首字延迟。模型处理期间，网关默认每 5 秒刷新一次
微信“正在输入”状态；可通过 `weixin.typingKeepaliveMs` 调整刷新间隔。

`GET /status` 还会显示队列深度、活动 worker、App Server PID、首个 delta 时间和
最近一条消息的分阶段耗时。只要 PID 保持不变，就说明没有退回到逐消息启动 Codex。

### 生成图片回传

Codex App Server 发出结构化 `imageGeneration` item 后，网关会读取其 `savedPath`，
校验文件真实路径、图片魔数、扩展名和大小，再自动上传微信 CDN。文本回复和图片分别
记录发送进度；每张图片使用稳定 `client_id`，进程中断后可继续发送而不重新运行模型。
目前自动回传 PNG、JPEG 和 WebP；普通文件与视频仍可复用媒体发送器，但尚未自动识别
任意工具生成的文件路径。

## 许可证

适配代码采用 MIT 许可证。腾讯微信协议实现的原始版权和许可见
`TENCENT-LICENSE` 与 `NOTICE`。这不是腾讯或 OpenAI 官方产品。
