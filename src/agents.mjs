import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

export class AgentRegistry {
  #adapters = new Map();

  register(name, adapter) {
    if (!name || !adapter?.run || !adapter?.capabilities) {
      throw new Error("agent adapters require a name, capabilities, and run()");
    }
    this.#adapters.set(name, adapter);
    return this;
  }

  get(name) {
    const adapter = this.#adapters.get(name);
    if (!adapter) throw new Error(`Agent "${name}" is unavailable`);
    return adapter;
  }

  has(name) {
    return this.#adapters.has(name);
  }

  async close() {
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close?.()));
  }
}

export const CODEX_CAPABILITIES = Object.freeze({
  input: ["text", "image", "file"],
  tools: ["agent"],
  approvals: true,
  continuation: true,
  native: true,
  usage: true,
  controls: ["steer", "interrupt", "approval"],
});

export const CLAUDE_CAPABILITIES = Object.freeze({
  input: ["text", "image", "file"],
  tools: ["agent"],
  approvals: true,
  continuation: true,
  native: true,
  usage: true,
  controls: ["interrupt", "approval"],
});

export class JsonLinePeer {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  constructor(command, args, options = {}) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32_768);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#emit({ type: "transport.invalid_json", line });
        return;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.#pending.get(String(message.id));
        if (pending) {
          this.#pending.delete(String(message.id));
          message.error ? pending.reject(rpcError(message.error)) : pending.resolve(message.result);
          return;
        }
      }
      this.#emit(message);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `Agent transport exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#emit({ type: "transport.exit", code, signal, error: error.message });
    });
    this.child.once("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  request(method, params = {}) {
    const id = String(this.#nextId++);
    const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.send({ id, method, params });
    return promise;
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    if (this.child.stdin.destroyed) throw new Error("Agent transport is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 500);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  #emit(message) {
    for (const listener of this.#listeners) listener(message);
  }
}

export class CodexAdapter {
  capabilities = CODEX_CAPABILITIES;

  constructor({ executable = "codex", appServerArgs = ["app-server", "--stdio"] } = {}) {
    this.executable = executable;
    this.appServerArgs = appServerArgs;
  }

  async *run(request) {
    const peer = new JsonLinePeer(this.executable, this.appServerArgs, {
      cwd: request.workspace.path,
    });
    const queue = eventQueue();
    const off = peer.onMessage(queue.push);
    let threadId;
    let turnId;
    try {
      await peer.request("initialize", {
        clientInfo: { name: "all-api", title: "All API", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      peer.notify("initialized", {});
      const overrides = request.profile.source === "managed" ? request.profile.overrides : {};
      const threadOverrides = pick(overrides, CODEX_THREAD_FIELDS);
      if (request.instructions) {
        threadOverrides.developerInstructions = [
          threadOverrides.developerInstructions,
          request.instructions,
        ].filter(Boolean).join("\n\n");
      }
      const thread = request.sessionId
        ? await peer.request("thread/resume", {
            threadId: request.sessionId,
            cwd: request.workspace.path,
            ...threadOverrides,
          })
        : await peer.request("thread/start", {
            cwd: request.workspace.path,
            ...threadOverrides,
          });
      threadId = thread.thread.id;
      const turn = await peer.request("turn/start", {
        threadId,
        input: toCodexInput(request.input),
        ...pick(overrides, CODEX_TURN_FIELDS),
      });
      turnId = turn.turn.id;
      request.signal?.addEventListener("abort", () => {
        peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      }, { once: true });

      for await (const message of queue) {
        if (message.method === "item/agentMessage/delta") {
          yield { type: "text.delta", delta: message.params.delta };
        } else if (message.id !== undefined && isInteractiveCodexRequest(message.method)) {
          peer.send({
            id: message.id,
            result: { decision: "decline" },
          });
          await peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
          throw new Error(
            `Codex requested interactive input (${message.method}); use the native endpoint or a non-interactive profile`,
          );
        } else if (message.method === "turn/completed" && message.params.turn.id === turnId) {
          const usage = codexUsage(message.params.turn);
          yield { type: "completed", sessionId: threadId, ...(usage && { usage }) };
          return;
        } else if (message.method === "turn/failed" && message.params.turn.id === turnId) {
          throw new Error(message.params.turn.error?.message ?? "Codex turn failed");
        }
      }
    } finally {
      off();
      queue.end();
      await peer.close();
    }
  }

  async openNative({ send }) {
    const peer = new JsonLinePeer(this.executable, this.appServerArgs);
    const off = peer.onMessage(send);
    return {
      receive: async (message) => peer.send(message),
      close: async () => {
        off();
        await peer.close();
      },
    };
  }
}

export class ClaudeAdapter {
  capabilities = CLAUDE_CAPABILITIES;

  constructor({ executable = "claude", query = claudeQuery } = {}) {
    this.executable = executable;
    this.query = query;
  }

  async *run(request) {
    const overrides = request.profile.source === "managed" ? request.profile.overrides : {};
    const claudeOptions = pick(overrides, CLAUDE_OPTION_FIELDS);
    const systemPrompt = claudeSystemPrompt(claudeOptions.systemPrompt, request.instructions);
    delete claudeOptions.systemPrompt;
    let interactiveRequest;
    const execution = this.query({
      prompt: await toClaudePrompt(request.input),
      options: {
        cwd: request.workspace.path,
        pathToClaudeCodeExecutable: this.executable,
        settingSources: ["user", "project", "local"],
        ...(request.sessionId ? { resume: request.sessionId } : {}),
        ...claudeOptions,
        ...(systemPrompt && { systemPrompt }),
        abortController: abortControllerFrom(request.signal),
        canUseTool: async (toolName) => {
          interactiveRequest = toolName;
          return {
            behavior: "deny",
            message: "Interactive approval is unavailable on standard HTTP protocols; use native",
          };
        },
      },
    });
    let sessionId = request.sessionId;
    for await (const message of execution) {
      if (interactiveRequest) {
        throw new Error(
          `Claude requested interactive approval for "${interactiveRequest}"; use the native endpoint or a non-interactive profile`,
        );
      }
      sessionId = message.session_id ?? sessionId;
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text") yield { type: "text.delta", delta: block.text };
          if (block.type === "tool_use") yield { type: "agent.tool", payload: block };
        }
      } else if (message.type === "result") {
        yield {
          type: "completed",
          sessionId,
          ...(message.usage && {
            usage: {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
            },
          }),
        };
        return;
      }
    }
    throw new Error("Claude Agent SDK ended without a result message");
  }

  async openNative({ send, workspace, profile, sessionId }) {
    const input = eventQueue();
    const pending = new Map();
    const overrides = profile.source === "managed"
      ? pick(profile.overrides, CLAUDE_OPTION_FIELDS)
      : {};
    const controller = new AbortController();
    const execution = this.query({
      prompt: input,
      options: {
        cwd: workspace.path,
        pathToClaudeCodeExecutable: this.executable,
        settingSources: ["user", "project", "local"],
        ...(sessionId ? { resume: sessionId } : {}),
        ...overrides,
        abortController: controller,
        canUseTool: (toolName, toolInput, options) => nativeDecision({
          pending,
          send,
          id: options.requestId,
          payload: {
            type: "permission_request",
            request_id: options.requestId,
            tool_name: toolName,
            input: toolInput,
            options: withoutSignal(options),
          },
          signal: options.signal,
          fallback: {
            behavior: "deny",
            message: "Native permission request was cancelled",
          },
        }),
        onUserDialog: (request, options) => {
          const id = `dialog_${cryptoRandomId()}`;
          return nativeDecision({
            pending,
            send,
            id,
            payload: { type: "user_dialog_request", request_id: id, request },
            signal: options.signal,
            fallback: { behavior: "cancelled" },
          });
        },
        supportedDialogKinds: overrides.supportedDialogKinds ?? ["refusal_fallback_prompt"],
      },
    });
    const pump = (async () => {
      try {
        for await (const output of execution) send(output);
      } catch (error) {
        if (!controller.signal.aborted) {
          send({ type: "transport.error", error: { message: error.message } });
        }
      } finally {
        for (const decision of pending.values()) decision.resolve(decision.fallback);
        pending.clear();
      }
    })();
    return {
      receive: async (message) => {
        if (message?.type === "permission_response" || message?.type === "user_dialog_response") {
          const decision = pending.get(message.request_id);
          if (!decision) throw new Error(`Unknown native request_id: ${message.request_id}`);
          pending.delete(message.request_id);
          decision.resolve(message.result);
          return;
        }
        if (message?.type === "interrupt") return execution.interrupt();
        if (message?.type === "set_permission_mode") return execution.setPermissionMode(message.mode);
        if (message?.type === "set_model") return execution.setModel(message.model);
        input.push(toSdkUserMessage(message));
      },
      close: async () => {
        input.end();
        await pump;
      },
    };
  }
}

export class ConnectorAdapter {
  constructor(definition) {
    this.definition = definition;
    this.capabilities = definition.capabilities;
  }

  async *run(request) {
    const peer = new JsonLinePeer(this.definition.command, this.definition.args ?? [], {
      cwd: request.workspace.path,
      env: { ...process.env, ...(this.definition.env ?? {}) },
    });
    const queue = eventQueue();
    const off = peer.onMessage(queue.push);
    try {
      await peer.request("initialize", {
        protocolVersion: 1,
        client: { name: "all-api", version: "0.2.0" },
      });
      const started = await peer.request("session/start", {
        model: request.model,
        profile: request.profile,
        workspace: request.workspace,
        sessionId: request.sessionId,
        input: request.input,
        tools: request.tools,
      });
      for await (const message of queue) {
        if (message.method !== "session/event" || message.params.sessionId !== started.sessionId) {
          continue;
        }
        yield message.params.event;
        if (message.params.event.type === "completed") return;
      }
    } finally {
      off();
      queue.end();
      await peer.close();
    }
  }

  async openNative({ send }) {
    const peer = new JsonLinePeer(this.definition.command, this.definition.args ?? []);
    const off = peer.onMessage(send);
    return {
      receive: async (message) => peer.send(message),
      close: async () => {
        off();
        await peer.close();
      },
    };
  }
}

export function createDefaultRegistry(config) {
  const registry = new AgentRegistry()
    .register("codex", new CodexAdapter())
    .register("claude", new ClaudeAdapter());
  for (const [name, definition] of Object.entries(config.connectors)) {
    registry.register(name, new ConnectorAdapter(definition));
  }
  return registry;
}

const CODEX_THREAD_FIELDS = [
  "model", "modelProvider", "approvalPolicy", "approvalsReviewer", "sandbox",
  "baseInstructions", "developerInstructions", "personality", "serviceTier", "config",
];
const CODEX_TURN_FIELDS = [
  "model", "approvalPolicy", "approvalsReviewer", "effort", "sandboxPolicy",
  "outputSchema", "summary", "personality", "serviceTier",
];
const CLAUDE_OPTION_FIELDS = [
  "model", "permissionMode", "allowDangerouslySkipPermissions", "allowedTools",
  "disallowedTools", "systemPrompt", "maxTurns", "maxBudgetUsd", "effort",
  "fallbackModel", "mcpServers", "hooks", "agents", "betas", "env",
  "supportedDialogKinds",
];

function pick(source = {}, allowed) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.includes(key)));
}

function toCodexInput(input) {
  const result = [];
  for (const block of normalizeBlocks(input)) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
    else if (block.type === "image_url") result.push({ type: "image", url: block.url });
    else if (block.type === "local_image") result.push({ type: "localImage", path: block.path });
    else if (block.type === "file") result.push({ type: "text", text: `[File: ${block.path}]` });
  }
  return result;
}

async function toClaudePrompt(input) {
  const blocks = normalizeBlocks(input);
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("\n");
  }
  const content = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image_url") {
      content.push({ type: "image", source: imageSource(block.url) });
    } else if (block.type === "local_image") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType ?? mediaType(block.path),
          data: (await readFile(block.path)).toString("base64"),
        },
      });
    } else if (block.type === "file" && /^https:\/\//.test(block.path)) {
      content.push({ type: "document", source: { type: "url", url: block.path } });
    } else if (block.type === "file") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: block.mediaType ?? mediaType(block.path),
          data: (await readFile(block.path)).toString("base64"),
        },
      });
    }
  }
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  })();
}

function normalizeBlocks(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return Array.isArray(input) ? input : [];
}

function codexUsage(turn) {
  const value = turn.usage ?? turn.tokenUsage;
  if (!value) return undefined;
  const input = value.inputTokens ?? value.input_tokens;
  const output = value.outputTokens ?? value.output_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { input_tokens: input, output_tokens: output };
}

function abortControllerFrom(signal) {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}

function eventQueue() {
  const values = [];
  const waiters = [];
  let ended = false;
  return {
    push(value) {
      const waiter = waiters.shift();
      waiter ? waiter({ value, done: false }) : values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function rpcError(error) {
  const result = new Error(error.message ?? "Agent RPC error");
  result.code = error.code;
  result.data = error.data;
  return result;
}

function isInteractiveCodexRequest(method) {
  return typeof method === "string" && (
    method.includes("requestApproval")
    || method === "permissions/requestApproval"
    || method === "item/tool/requestUserInput"
    || method === "item/tool/call"
  );
}

function imageSource(url) {
  if (!url.startsWith("data:")) return { type: "url", url };
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) throw new Error("Only base64 data URLs are supported for inline images");
  return { type: "base64", media_type: match[1], data: match[2] };
}

function mediaType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
  }[extension] ?? "application/octet-stream";
}

function claudeSystemPrompt(configured, requested) {
  if (!requested) return configured;
  if (!configured) {
    return { type: "preset", preset: "claude_code", append: requested };
  }
  if (typeof configured === "string") return `${configured}\n\n${requested}`;
  return {
    ...configured,
    append: [configured.append, requested].filter(Boolean).join("\n\n"),
  };
}

function toSdkUserMessage(message) {
  if (message?.type === "user" && message.message) return message;
  if (typeof message === "string") {
    return {
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    };
  }
  throw new Error("Claude native input must be an SDKUserMessage or a supported control message");
}

function nativeDecision({ pending, send, id, payload, signal, fallback }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(fallback);
    const entry = { resolve, fallback };
    pending.set(id, entry);
    signal?.addEventListener("abort", () => {
      if (pending.delete(id)) resolve(fallback);
    }, { once: true });
    send(payload);
  });
}

function withoutSignal({ signal, ...value }) {
  return value;
}

function cryptoRandomId() {
  return crypto.randomUUID();
}
