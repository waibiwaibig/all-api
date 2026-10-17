# 持久秘书服务

All API 增加可选的秘书服务，与原有协议桥接层分开。标准模型 API 和 Native 转发继续保留各自边界；秘书服务承担稳定身份、排队、消息幂等、任务查询和底层会话续接。外部客户端只面对同一个秘书。

## 初始化

需要 Node.js 22.18 或更新版本。默认在 Knock 主机所在机器运行 All API 和连接程序；WSL 部署就在 WSL 内执行以下步骤。先启动该机器已配置的 All API，再由本机管理接口建立秘书：

```sh
all-api secretary init --model codex --workspace default \
  --name 秘书 \
  --output /private/secretary.json
```

命令创建专用 Access Key，限定所选模型与工作区，写出仅属主可读写的连接文件。stdout 只返回文件位置。已有文件和已有秘书配置会被拒绝覆盖。省略 `--url` 时，地址由该实例的监听端口生成，使用 `http://127.0.0.1:<port>`。只有明确选择外部秘书服务时才传入 HTTPS origin。执行安装的电脑不改变默认部署位置。

连接文件包含 `version: 1`、`protocol: "a2a/1.0"`、固定 `id`、显示名 `name`、`agentCardUrl` 和私密 `token`。不要把它加入 Git 或聊天记录。模型、权限和工作目录留在 All API 主机配置中。

WSL 2 NAT 部署需要使用 Windows 上已有的 HTTP 代理时，可执行 `all-api autostart on --wsl-proxy-port 7890`，然后重启对应 user systemd 服务。端口必须取自实际代理配置，代理需要允许 WSL 访问。启动器每次启动都从系统路由解析 Windows 主机地址，避免 WSL 重启后地址变化；本机回环通信不走代理。设置保存在该实例的 `autostart.json`，后续启用自启动时保留；传入 `--wsl-proxy-port off` 可移除。它只设置 All API 进程环境，不更改 Windows 系统代理或其他服务。

秘书密钥只能读取自己所属的 Agent Card 和任务。其他普通 Access Key 或 Native Key 无权访问秘书接口。删除专用密钥会停止接受新请求；已经开始的外部操作需要独立检查。

## 协议

采用官方 `@a2a-js/sdk` 1.3.0，实现 A2A 1.0 JSON-RPC：

- `GET /.well-known/agent-card.json`：认证后发现能力。
- `POST /a2a`：`SendMessage`、`GetTask`、`CancelTask`。
- 一条消息包含一段 `text/plain`，最多 8000 UTF-8 字节；当前不支持流式、附件、客户端工具帧、tenant 或 webhook。
- `SendMessage.configuration.returnImmediately` 为 true 时立即返回已落盘 Task；为 false 时等待终态或需要输入的状态。
- `contextId` 对整个秘书固定。客户端省略它即可继续；客户端无需选择线程。每条新消息生成一个 Task。
- `CancelTask` 仅取消尚未启动的任务。运行中的操作不作已撤销承诺。

Agent Card 声明 `urn:all-api:durable-message:1`。请求需带 `A2A-Version: 1.0` 和 `A2A-Extensions: urn:all-api:durable-message:1`。该扩展要求同一 `messageId`、相同原文与上下文始终返回原 Task；冲突复用直接拒绝。普通 A2A 不足以独立保证操作不重做，连接程序必须检查这项声明。

## 状态与恢复

秘书使用独立 SQLite WAL 数据库，接受请求前持久写入，按入队顺序串行执行。最多允许 256 项未完成任务，单项文字结果最多 1 MiB。一个实例持有独占状态锁，防止另一进程在启动恢复时改写正在执行的任务。

`SUBMITTED` 表示已落盘；`WORKING` 表示已开始 Agent 执行；`COMPLETED` 仅在 Agent 正式完成后写入。需要原生交互授权时返回 `INPUT_REQUIRED`。执行异常或重启发现 `WORKING` 时返回 `FAILED`，并通过 `metadata.outcome: "unconfirmed"` 说明此前操作可能已有副作用；这些消息不自动重放。未开始的排队任务可继续执行。

服务保存每条用户输入、最终任务结果、公开上下文 ID 和底层会话 ID。此存储规则仅属于显式启用的秘书服务；原有标准接口的 30 天 Responses 保留策略不变。秘书记录目前由用户管理的状态目录长期保留，备份时应与 Agent 原生历史及工作区笔记一起保存。

## 长期连续性

Codex 使用官方 `thread/resume`，Claude 使用 SDK 的 `resume`。底层 session 生成后立即保存映射，随后每条消息只提交新增输入。Agent 原生历史是执行上下文的来源；工作区 `.secretary/<连接 ID>/memory/` 是持久笔记位置。秘书指令要求维护任务索引和必要的长期记录，并在相关工作前查阅。

这提供持久入口与上下文续接。记忆质量、跨项目任务分解、主动调度及多 Agent 协作依赖后端能力和后续评估。这里没有引入第二套模型推理框架，也没有自动把不相容的 Agent session 转成新会话。后端类型改变时明确停止并要求主机处理上下文转接；普通权限和原生模型参数更新可在下一轮恢复时生效。

权限继续遵从 Agent 原有策略。接口不自动同意原生批准请求。当前授权请求结束本轮，返回需要关注的状态；用户在主机处理策略后明确发出继续指令。连接层无需实现每家 Agent 的权限面板。

## Knock 接入

Knock 的电脑连接程序加载上述 JSON，以 A2A 提交并轮询 Task，使用自己的持久消息日志处理网络重试。秘书不导入 Knock 的代码、不保存 Knock 的 APNs 配置，也不依赖 Knock 才能运行。Knock 使用独立 receiver 接收手机消息，再通过既有 sender/outbox 返回秘书结果；普通通知发送者完全独立。

## 依据与验证

[A2A JavaScript SDK README](https://github.com/a2aproject/a2a-js#capability-overview) 的 Servers、Clients、Custom event bus and task store 小节提供协议处理器和持久化扩展点。[Codex App Server](https://learn.chatgpt.com/docs/app-server) 的线程生命周期、`thread/resume`、`turn/start` 和 `turn/completed` 部分对应后端会话管理与成功判定。

`test/secretary.test.mjs` 使用官方 A2A 客户端验证重发幂等、内容冲突、重启续接、串行队列、排队取消、密钥隔离与崩溃后的不重放行为。Mock 检查不代表真实 Agent 版本认证；实际 Codex/Claude 验收需分别记录。

## 2026-10-17 本地与部署验收

- All API 0.5.0：语法检查通过，自动测试 57 项通过、3 项真实 Agent 测试默认跳过；测试不代替真实认证。
- macOS 上使用 Codex 0.162.0-alpha.17.2 实际运行两轮 A2A 请求，第二轮在同一公开 contextId 恢复首轮校验词。随后安装发布 tarball，并以 launchd 常驻运行；服务重启后原 Task 仍保存在 SQLite 中。
- Knock 0.3.0 使用独立 receiver 和状态目录连接该 API；它通过公开 JSON 文件和 A2A 协议接入，没有导入 All API 实现。
- Claude 的秘书连续对话尚未进行真实登录环境验收。长期记忆检索、跨项目并行工作与长时间离线恢复，需要独立使用评估。

- 真机两轮自动收发通过：手机发送“记住检验词：松果 829”，秘书回复“已记住：松果 829”；后续询问得到“松果 829”。两轮任务完成、回复由主机存储且 APNs 各一次接受；用户确认两次均收到且内容正确。底层继续使用先前 API 测试的同一上下文，跨服务重启后续接成功。
- 已移除试验用 Codex Stop 自动通知钩子及其独立会话接收服务，撤销其 receiver；历史记录保留。普通 Knock 通知发送服务和新的秘书连接服务分别运行。

### 同日切换为 WSL 部署主机

- 按部署位置规则，将秘书执行、状态和 Knock 连接程序移到私人 Knock 主机所在的 WSL；Mac 的秘书服务已停用。All API 仅监听 WSL 本机 `127.0.0.1:8789`，连接程序通过本机 A2A 访问。
- 保留公开秘书身份、任务记录和原生会话历史；恢复会话时显式使用 WSL 当前模型配置。真实 A2A 请求成功返回手机此前给出的“松果 829”，上下文连续性验证通过。
- WSL 原生 Codex 需要 Windows 现有代理。已验证端口 7890，并为 All API 自启动配置动态解析 WSL NAT 默认路由；服务重启后真实请求通过。All API、Knock 连接程序和私人主机均为 active、enabled。
- 本次版本检查：语法检查通过，61 项测试通过、3 项真实 Agent 测试跳过。WSL 真实调用结果单独验证。
- 切换后用户再次从 Knock 手机秘书页询问校验词，并明确确认自动收到“松果 829”。WSL 执行、历史续接和手机往返验收通过。
