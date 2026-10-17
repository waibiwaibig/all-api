import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentCard, Task, TaskState as S, Role } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  RequestMalformedError,
  TaskNotFoundError,
  TaskNotCancelableError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { HttpError } from "./core.mjs";

export const DELIVERY_EXTENSION = "urn:all-api:durable-message:1";
const active = (state) =>
  [S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING].includes(state);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const malformed = (message) => new RequestMalformedError({ message });

// One durable public identity, independent of an engine's thread identifier.
// SQLite owns acceptance/idempotency; the official SDK owns A2A wire encoding.
export class Secretary {
  constructor({ config, directory, prepareRun }) {
    this.config = config;
    this.prepareRun = prepareRun;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(path.join(directory, "owner.sqlite"));
    chmodSync(path.join(directory, "owner.sqlite"), 0o600);
    try {
      this.lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.lock.close();
      throw new Error("Secretary state is already in use", { cause: error });
    }
    this.db = new DatabaseSync(path.join(directory, "secretary.sqlite"));
    chmodSync(path.join(directory, "secretary.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),context TEXT NOT NULL,session TEXT,binding TEXT);
      CREATE TABLE IF NOT EXISTS tasks(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,message TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO identity(id,context) VALUES(1,?)")
      .run(randomUUID());
    for (const row of this.db.prepare("SELECT id,result FROM tasks").all()) {
      const task = JSON.parse(row.result);
      if (task.status.state === S.TASK_STATE_WORKING) {
        this.finish(
          task,
          S.TASK_STATE_FAILED,
          "服务在执行期间中断。此前操作的结果需要检查；本任务不会自动重复执行。",
          { outcome: "unconfirmed" },
        );
      }
    }
    this.transport = new JsonRpcTransportHandler(this);
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
  }
  settings() {
    const s = this.config.secretary;
    if (!s)
      throw new HttpError(404, "Secretary is not configured", "not_found");
    return s;
  }
  authorize(grant) {
    const s = this.settings();
    if (grant.kind !== "access" || grant.keyId !== s.keyId)
      throw new HttpError(
        403,
        "Secretary credential required",
        "permission_denied",
      );
  }
  identity() {
    return this.db.prepare("SELECT * FROM identity WHERE id=1").get();
  }
  async getAgentCard() {
    const s = this.settings();
    return AgentCard.fromJSON({
      name: s.name,
      description:
        "A persistent personal secretary. Models and engine sessions are managed by the service.",
      version: "1.0.0",
      supportedInterfaces: [
        {
          url: `${s.url}/a2a`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: DELIVERY_EXTENSION,
            required: true,
            description:
              "Same messageId and content returns the original durable task; conflicting reuse is rejected. One service-owned context.",
          },
        ],
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
      },
      securityRequirements: [{ schemes: { bearer: [] } }],
      skills: [
        {
          id: "secretary",
          name: "Personal secretary",
          description:
            "Continue the same personal context using the configured local agent.",
          tags: ["assistant"],
        },
      ],
    });
  }
  async rpc(body, grant, headers) {
    this.authorize(grant);
    if (headers["a2a-version"] !== "1.0")
      throw new HttpError(400, "A2A-Version: 1.0 is required");
    if (
      !String(headers["a2a-extensions"] ?? "")
        .split(",")
        .map((x) => x.trim())
        .includes(DELIVERY_EXTENSION)
    ) {
      throw new HttpError(
        400,
        `A2A-Extensions: ${DELIVERY_EXTENSION} is required`,
      );
    }
    if (!["SendMessage", "GetTask", "CancelTask"].includes(body.method)) {
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: JsonRpcTransportHandler.mapToJSONRPCError(
          new UnsupportedOperationError(),
        ),
      };
    }
    return this.transport.handle(
      body,
      new ServerCallContext({
        requestedVersion: "1.0",
        user: { isAuthenticated: true, userName: grant.keyId },
      }),
    );
  }
  async sendMessage(params) {
    const m = params.message,
      c = params.configuration;
    if (
      params.tenant ||
      !m ||
      m.role !== Role.ROLE_USER ||
      !/^[\w-]{1,128}$/.test(m.messageId) ||
      m.taskId ||
      m.referenceTaskIds.length ||
      m.parts.length !== 1 ||
      m.parts[0].content?.$case !== "text" ||
      m.parts[0].filename ||
      (m.parts[0].mediaType && m.parts[0].mediaType !== "text/plain")
    )
      throw malformed(
        "One user text message with a stable messageId is required",
      );
    const text = m.parts[0].content.value;
    if (!text.trim() || Buffer.byteLength(text) > 8000)
      throw malformed("Text must fit within 8000 UTF-8 bytes");
    if (
      c?.taskPushNotificationConfig ||
      c?.acceptedOutputModes?.some((x) => x !== "text/plain")
    )
      throw malformed("Only text/plain output and polling are supported");
    if (m.contextId && m.contextId !== this.identity().context)
      throw malformed("Unknown context");
    const digest = hash({
      text,
      context: m.contextId || this.identity().context,
    });
    const previous = this.db
      .prepare("SELECT * FROM tasks WHERE message=?")
      .get(m.messageId);
    let task;
    if (previous) {
      if (previous.digest !== digest)
        throw malformed("messageId was already used with different content");
      task = JSON.parse(previous.result);
    } else {
      if (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM tasks WHERE json_extract(result,'$.status.state') IN (1,2)",
          )
          .get().n >= 256
      )
        throw malformed("Secretary queue is full");
      task = Task.fromJSON({
        id: randomUUID(),
        contextId: this.identity().context,
        status: {
          state: "TASK_STATE_SUBMITTED",
          timestamp: new Date().toISOString(),
        },
      });
      this.db
        .prepare(
          "INSERT INTO tasks(id,message,digest,input,result) VALUES(?,?,?,?,?)",
        )
        .run(task.id, m.messageId, digest, text, JSON.stringify(task));
    }
    this.wake();
    if (!c?.returnImmediately) {
      while (!this.closed && active(task.status.state)) {
        await delay(100);
        task = await this.getTask({ id: task.id });
      }
    }
    return task;
  }
  async getTask({ id, tenant }) {
    if (tenant) throw malformed("Tenants are not supported");
    const row = this.db.prepare("SELECT result FROM tasks WHERE id=?").get(id);
    if (!row) throw new TaskNotFoundError();
    return JSON.parse(row.result);
  }
  async cancelTask(params) {
    const task = await this.getTask(params);
    // Canceling queued work is definitive. Active work has external effects and
    // must be interrupted by its engine; never label a running operation canceled.
    if (task.status.state !== S.TASK_STATE_SUBMITTED)
      throw new TaskNotCancelableError();
    this.finish(task, S.TASK_STATE_CANCELED, "任务已取消，尚未开始执行。");
    return task;
  }
  save(task) {
    this.db
      .prepare("UPDATE tasks SET result=? WHERE id=?")
      .run(JSON.stringify(task), task.id);
  }
  finish(task, state, text, metadata) {
    task.status = { state, timestamp: new Date().toISOString() };
    task.metadata = metadata;
    if (text)
      task.artifacts = [
        {
          artifactId: task.id,
          name: "reply",
          description: "",
          extensions: [],
          parts: [
            {
              content: { $case: "text", value: text },
              filename: "",
              mediaType: "text/plain",
            },
          ],
        },
      ];
    this.save(task);
  }
  wake() {
    if (this.running || this.closed || !this.config.secretary) return;
    this.running = this.drain()
      .catch(() => {
        /* Durable status remains queryable; next tick retries only unstarted work. */
      })
      .finally(() => {
        this.running = null;
      });
  }
  async drain() {
    while (!this.closed) {
      const row = this.db
        .prepare(
          "SELECT * FROM tasks WHERE json_extract(result,'$.status.state')=1 ORDER BY seq LIMIT 1",
        )
        .get();
      if (!row) return;
      const task = JSON.parse(row.result),
        s = this.settings(),
        identity = this.identity();
      const binding = hash([
        s.model,
        s.workspace,
        this.config.models[s.model]?.agent,
      ]);
      if (identity.binding && identity.binding !== binding) {
        this.finish(
          task,
          S.TASK_STATE_FAILED,
          "秘书的执行配置已改变。请在主机确认上下文转接后继续。",
          { outcome: "configuration_changed" },
        );
        continue;
      }
      const memory = path.join(
        this.config.workspaces[s.workspace].path,
        ".secretary",
        s.id,
        "memory",
      );
      mkdirSync(memory, { recursive: true, mode: 0o700 });
      const key = this.config.keys[s.keyId];
      let run;
      try {
        if (!key) throw new Error("Secretary credential revoked");
        run = await this.prepareRun(
          { keyId: s.keyId, kind: "access", ...key },
          s.model,
          s.workspace,
          {
            onSession: (sessionId) =>
              this.db
                .prepare("UPDATE identity SET session=? WHERE id=1")
                .run(sessionId),
            protocol: "responses",
            rawEvents: true,
            input: [{ type: "text", text: row.input }],
            sessionId: identity.session || undefined,
            instructions: `You are the user's persistent personal secretary. Maintain continuity and manage internal work without asking the user to choose engine sessions or models. Honor the user's authorization and the engine's permission policy. Never claim an operation succeeded without evidence. Maintain concise durable notes and a task index in ${memory}; consult relevant notes before work and update them after meaningful outcomes. These files persist across context compaction. Do not store credentials in notes.`,
          },
        );
      } catch (error) {
        if (error.status === 429) return;
        this.finish(
          task,
          S.TASK_STATE_FAILED,
          "秘书暂时无法启动。请检查主机的 Agent 登录、版本认证和执行配置。",
          { outcome: "not_started", code: error.code ?? "agent_unavailable" },
        );
        continue;
      }
      const latest = await this.getTask({ id: task.id });
      if (
        this.closed ||
        latest.status.state !== S.TASK_STATE_SUBMITTED ||
        !this.config.keys[s.keyId]
      ) {
        run.discard();
        if (!this.closed && latest.status.state === S.TASK_STATE_SUBMITTED)
          this.finish(task, S.TASK_STATE_FAILED, "秘书连接凭证已撤销。", {
            outcome: "not_started",
          });
        continue;
      }
      task.status = {
        state: S.TASK_STATE_WORKING,
        timestamp: new Date().toISOString(),
      };
      this.save(task);
      this.db.prepare("UPDATE identity SET binding=? WHERE id=1").run(binding);
      let output = "",
        completed = false;
      try {
        for await (const event of run.events) {
          if (event.sessionId)
            this.db
              .prepare("UPDATE identity SET session=? WHERE id=1")
              .run(event.sessionId);
          if (event.type === "text.delta") {
            output += event.delta;
            if (Buffer.byteLength(output) > 1024 * 1024) {
              run.controller.abort();
              throw new Error("Output exceeds limit");
            }
          }
          if (event.type === "completed") {
            this.finish(task, S.TASK_STATE_COMPLETED, output || "已完成。");
            completed = true;
          }
          if (event.type === "interrupted") {
            this.finish(
              task,
              S.TASK_STATE_INPUT_REQUIRED,
              "这项操作需要额外授权，当前执行已停止。请在主机检查权限策略，再明确告诉我继续。",
              { outcome: "input_required" },
            );
            completed = true;
          }
        }
        if (!completed) throw new Error("Agent ended without a final status");
      } catch {
        this.finish(
          task,
          S.TASK_STATE_FAILED,
          "执行中断，部分操作可能已经发生。我会保留上下文；请先检查结果再决定是否继续。",
          { outcome: "unconfirmed" },
        );
      }
    }
  }
  stop() {
    this.closed = true;
    clearInterval(this.timer);
  }
  async close() {
    this.stop();
    await this.running;
    this.db.close();
    this.lock.close();
  }
}
