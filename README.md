# All API

All API 是运行在 Agent 同一台机器上的桥接器。它把本机 Codex、Claude
以及外部连接器暴露成 OpenAI、Anthropic 和原生协议，同时保留 Agent 自己的
配置、权限、工具与会话。

```mermaid
flowchart LR
    C["OpenAI / Anthropic 客户端"] --> HTTP["严格标准协议转换"]
    N["高级客户端"] --> WS["Native WebSocket 原样事件"]
    HTTP --> R["Key + 模型配置 + 工作区"]
    WS --> R
    R --> CX["Codex app-server"]
    R --> CL["Claude Agent SDK → 本机 claude"]
    R --> P["外部 Agent 连接器"]
```

完整产品决策和更多架构图见 [DECISION_MAP.md](./DECISION_MAP.md)。

## 安装与启动

要求 Node.js 20 或更新版本。Codex、Claude 可以预先安装，也可以稍后由
All API 调用官方安装渠道安装。

```sh
npm install -g @waibiwaibig/all-api
all-api init --workspace /absolute/path/to/project
all-api up
```

`init` 会检测本机 Agent，登记工作目录，并输出只显示一次的 Access Key。
服务默认只监听 `127.0.0.1:8787`。配置和 Key 哈希保存在 `~/.all-api`；
可用 `ALL_API_HOME` 改变该目录。

```sh
all-api status
all-api down
all-api autostart on
```

`up` 后台运行，`serve` 前台运行。管理操作只通过本机 Unix socket（Windows
为 named pipe）执行，不存在公网 Admin Key。

## 客户端接口

| 用途 | 接口 | 输入输出 |
|---|---|---|
| OpenAI 旧生态 | `POST /v1/chat/completions` | Chat Completions |
| OpenAI 新生态 | `POST /v1/responses` | Responses |
| Anthropic 生态 | `POST /v1/messages` | Messages |
| 完整 Agent 能力 | `WS /v1/native/sessions` | 薄信封内的 Agent 官方消息 |
| 模型发现 | `GET /v1/models` | 按请求头返回 OpenAI 或 Anthropic 形状 |
| 文件 | `/v1/files` | 按请求头返回 OpenAI 或 Anthropic 形状 |
| 能力与工作区 | `GET /allapi/v1/catalog` | All API 能力目录 |

标准协议是严格兼容层：未知参数、无法表达的输入、客户端工具或交互审批会明确
失败，不会被静默忽略。Native 只使用：

```json
{"type":"agent.input","payload":{"method":"turn/steer","params":{}}}
```

返回：

```json
{"type":"agent.event","payload":{"method":"turn/started","params":{}}}
```

其中 `payload` 不加工。Codex Native 对应 app-server JSON-RPC；Claude Native
对应 Agent SDK 消息。

OpenAI 示例：

```sh
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer allapi_..." \
  -H "Content-Type: application/json" \
  -H "X-AllAPI-Workspace: default" \
  -d '{"model":"codex","input":"检查当前项目并给出摘要"}'
```

Anthropic 示例：

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "X-Api-Key: allapi_..." \
  -H "Anthropic-Version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -H "X-AllAPI-Workspace: default" \
  -d '{"model":"claude","max_tokens":1024,"messages":[{"role":"user","content":"检查项目"}]}'
```

Key 只有一个工作区时可省略 `X-AllAPI-Workspace`。Key 授权多个工作区时必须
明确选择。调用方永远不能直接传任意本地路径。

## 模型配置、工作区和 Key

模型名是 Agent 配置单，不是独立的大模型名称。`source=local` 每次运行直接
继承本机 Agent 的实时配置；`source=managed` 只保存要覆盖的原生参数。

```sh
all-api model put codex:review \
  --agent codex \
  --source managed \
  --overrides '{"model":"gpt-5.4","approvalPolicy":"never","sandbox":"read-only"}'

all-api workspace add work /absolute/path/to/project
all-api key create phone --models codex:review --workspaces work
all-api models
all-api workspaces
all-api keys
```

修改模型配置和创建 Key 是两套接口。Key 只选择可用模型和工作区，不携带模型
内部参数。删除仍被 Key 使用的模型或工作区会失败。

## Agent 管理

```sh
all-api agent detect
all-api agent install codex
all-api agent install claude
all-api agent update codex
all-api agent update claude
```

- Codex 使用官方 `codex app-server --stdio`，不解析 TUI。
- Claude 使用官方 Agent SDK，并显式连接 PATH 中的本机 `claude`。
- 安装使用官方 npm 包；Claude 更新会优先调用官方 `claude update`。
- Agent 登录仍由 Agent 自己完成，All API 不保存登录凭据。

外部连接器通过本地 JSON-lines RPC 加入：实现 `initialize`、`session/start`，
并用 `session/event` 通知返回标准内部事件；Native 则原样交换连接器消息。

```sh
all-api connector put my-agent \
  --command /absolute/path/to/connector \
  --args '[]' \
  --capabilities '{"input":["text"],"tools":[],"approvals":false,"continuation":true,"native":true,"usage":false}'
all-api model put my-agent --agent my-agent
```

新增或替换连接器后重启服务，使 Agent 注册表重新加载。

## 暴露到公网

三种方式都仍由本机 All API 调用本机 Agent；All API 不运营公共 relay。

```sh
# Cloudflare Named Tunnel（首次会打开官方登录）
all-api expose cloudflare setup --hostname api.example.com
all-api expose cloudflare start

# Tailscale Funnel
all-api expose tailscale start

# 用户自己的 SSH relay
all-api expose relay start --host user@example.com --remote-port 8787
```

也可用 `all-api expose direct on` 改为监听所有网卡；该模式需要自行配置 TLS、
防火墙和端口转发，修改后需重启服务。Cloudflare 和 Tailscale 继续使用各自
官方客户端的免费额度、账户规则和访问控制。

## 会话、隐私与失败语义

- Chat Completions 和 Messages 是无状态转换；Responses 用不透明映射续接
  Agent 会话；Native 直接使用 Agent 会话。
- Agent 是对话历史的唯一事实来源。All API 只保存 Response ID、Agent 会话
  ID、状态、模型、工作区和官方 usage，不保存提示词或回复正文。
- 明确上传的 Files 保存在本机、按 Key 隔离，直到调用者删除。
- HTTP 客户端断线不会取消任务；只有 Responses cancel 或 Native 的官方中断
  操作会取消。
- 服务崩溃时，进行中的 Response 标记为 `interrupted`，不会自动重放。
- usage 只在 Agent 返回真实数据时出现，不估算、不填零。
- 达到全局并发上限时立即返回 busy 错误，不建立 All API 自己的排队系统。
- 默认不记录请求正文；仅在主动设置 `ALL_API_DEBUG=1` 时输出详细内部错误。

## 开发

```sh
npm install
npm run check
npm test
```

测试覆盖严格协议、Key/工作区隔离、两种错误方言、Files、Responses 续接、
Native 原样事件、官方 Agent 接缝、本地管理 socket、断线与显式取消。
