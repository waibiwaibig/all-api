# 统一 Agent API

All API 运行通用 Agent，应用拥有业务身份、角色、长期记忆和用户任务。Codex、Claude 的原生会话、指令位置、结构化输出和执行状态由本服务统一处理。应用与执行服务可以位于不同机器；工具及文件访问发生在执行服务授权的工作区。

## 连接与部署

```sh
all-api up
all-api agent export --model codex --workspace default --output /private/agent-api.json
```

命令创建仅允许指定 Agent 配置及工作区的 Access Key，输出属主可读写的 JSON 文件，包含 `version: 1`、`protocol: "a2a/1.0"`、`agent`、`agentCardUrl` 和 `token`。不包含应用身份或秘书名称。每个调用方应使用独立密钥。默认地址来自本实例实际端口；远程部署使用 `--url https://agents.example.com` 设置公布的服务 origin，并通过 TLS 反向代理连接本机监听端口。重复导出创建独立访问密钥，不重建应用状态。

WSL 2 NAT 访问 Windows 已有 HTTP 代理时，使用 `all-api autostart on --wsl-proxy-port 7890`，端口以真实代理配置为准。每次启动解析默认路由，回环通信不走代理；`--wsl-proxy-port off` 删除此设置。配置仅影响该 All API 实例。

## 统一执行契约

官方 `@a2a-js/sdk` 1.3.0 负责 A2A 1.0 JSON-RPC 编解码。认证的 `GET /.well-known/agent-card.json` 返回可用 Agent 配置；`POST /a2a` 提供 `SendMessage`、`GetTask`、`CancelTask`。接口当前提供文字输入、文字或 JSON 结果和轮询。

请求携带 `A2A-Version: 1.0` 与 `A2A-Extensions: urn:all-api:execution:1`。此必需扩展定义：

- 调用方传入稳定 `messageId` 与 `contextId`。访问密钥隔离上下文、消息去重和任务查询。
- `message.metadata.execution` 包含 `agent`，可选 `instructions` 和自包含 JSON Schema `responseSchema`。文字输入与指令各最多 128 KiB，Schema 最多 64 KiB。
- 上下文绑定 Agent 配置、后端类型和授权工作区。一个上下文内顺序执行，不同上下文可在实例并发上限内独立执行。应用更换执行配置时建立新上下文并提供业务记忆；接口不会把旧会话冒充为新后端的原生会话。
- 同一密钥下重复 `messageId` 与相同内容、上下文和执行参数返回原 Task。任何内容或参数冲突均拒绝；请求先持久化再执行。最多允许每个密钥 256 项未完成任务。
- `returnImmediately: true` 立即返回 Task。`GetTask` 在重启后仍可查询。`CancelTask` 只确认取消尚未开始的任务。

All API 不注入秘书提示词或读写应用记忆目录。调用方传入的指令进入 Codex developer instructions 或 Claude system prompt。`responseSchema` 转为 Codex 当前轮 `outputSchema` 或 Claude SDK `outputFormat`；结果在服务端统一验证后以 A2A `application/json` data part 返回。原生 session ID 保存在服务端。Knock 无需包含后端类型判断。

## 状态与故障

SQLite WAL 保存上下文、任务和去重记录，独占状态锁阻止多个进程共用同一执行数据库。`SUBMITTED` 表示持久接受，`WORKING` 表示执行开始，`COMPLETED` 表示 Agent 完成且结果校验通过。结果上限为 1 MiB。

需要交互授权时返回统一 `INPUT_REQUIRED`，当前运行已停止；此接口不会自动批准。运行或结果校验中断、重启发现运行中的任务时，返回 `FAILED` 和 `metadata.outcome: "unconfirmed"`，禁止自动重放。调用方应检查实际操作结果后决定后续动作。无法启动返回 `not_started`。本契约没有宣称外部副作用恰好执行一次。

执行记录当前长期保存于实例 `agent-executions/`，由服务运营者备份和管理。Agent 原生历史也需保存。应用记忆与业务档案属于调用方，不能依靠服务端任务库代替。

## 实现与验证位置

- `src/agent-service.mjs`：通用持久任务、访问隔离、上下文、排队和统一状态。
- `src/agents.mjs`：Codex、Claude 原生会话、指令和结构化结果适配。
- `test/agent-service.test.mjs`：官方客户端验证去重、上下文隔离、重启、不重放与 JSON 结果。
- `test/agents.test.mjs`：两个后端归一为相同结构化事件及续接语义；模拟测试与真实 Agent 验收分别报告。

依据：[Codex App Server](https://developers.openai.com/codex/app-server) 的 Start a turn 部分定义 `outputSchema` 的逐轮作用域及 `turn/completed`；[Claude Agent SDK structured outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs) 的 Define your schema 部分定义 `outputFormat` 和 `structured_output`。本实现使用这些原生机制并进行统一结果校验。

管理命令仅连接已经运行的服务。服务尚未就绪时明确报错，不创建临时管理进程或另行写入配置，避免启动过程读取旧凭证。
