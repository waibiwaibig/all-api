import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

const CERTIFIED_CODEX_VERSION = "0.162.0-alpha.17.2";
const CERTIFIED_CLAUDE_VERSIONS = new Set(["2.1.119"]);
const CERTIFIED_CLAUDE_SDK_VERSION = "0.3.220";

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
  input: ["text", "image"],
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
  #rpcTimeoutMs;
  #listeners = new Set();
  #rawListeners = new Set();
  #failureListeners = new Set();

  constructor(command, args, options = {}) {
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
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
      for (const listener of this.#rawListeners) listener(line);
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
          clearTimeout(pending.timer);
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
      error.exitCode = code;
      error.signal = signal;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#emit({ type: "transport.exit", code, signal, error: error.message });
      for (const listener of this.#failureListeners) listener(error);
    });
    this.child.once("error", (error) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      for (const listener of this.#failureListeners) listener(error);
    });
  }

  request(method, params = {}) {
    const id = String(this.#nextId++);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error(`Agent RPC timed out after ${this.#rpcTimeoutMs}ms: ${method}`);
        error.code = "agent_timeout";
        reject(error);
      }, this.#rpcTimeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      this.send({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      clearTimeout(pending?.timer);
      this.#pending.delete(id);
      pending?.reject(error);
    }
    return promise;
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    if (this.child.stdin.destroyed) throw new Error("Agent transport is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(frame, isBinary = false) {
    if (isBinary) throw new Error("This Agent native protocol accepts text frames only");
    const text = Buffer.isBuffer(frame) ? frame.toString("utf8") : String(frame);
    if (/[\r\n]/.test(text)) throw new Error("Native JSON-line frames must not contain newlines");
    if (this.child.stdin.destroyed) throw new Error("Agent transport is closed");
    this.child.stdin.write(`${text}\n`);
  }

  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onRaw(listener) {
    this.#rawListeners.add(listener);
    return () => this.#rawListeners.delete(listener);
  }

  onFailure(listener) {
    this.#failureListeners.add(listener);
    return () => this.#failureListeners.delete(listener);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 500);
    const force = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    terminate.unref();
    force.unref();
    await exited;
    clearTimeout(terminate);
    clearTimeout(force);
  }

  #emit(message) {
    for (const listener of this.#listeners) listener(message);
  }
}

export class CodexAdapter {
  capabilities = CODEX_CAPABILITIES;
  native = Object.freeze({
    transport: "websocket-json",
    protocol: "codex-app-server-jsonrpc",
    protocolVersion: null,
    resumable: true,
    clientTools: true,
    workspaceFromFrames: true,
  });

  constructor({ executable = "codex", appServerArgs = ["app-server", "--stdio"] } = {}) {
    this.executable = executable;
    this.appServerArgs = appServerArgs;
  }

  describe() {
    return executableDescription(this.executable);
  }

  async verifyStandard() {
    const description = await this.describe();
    if (this.standardVersion !== description.version) {
      this.standardVersion = description.version;
      this.standardCompatibility = verifyCodexStandard(
        this.executable,
        Promise.resolve(description),
      );
    }
    return this.standardCompatibility;
  }

  async *run(request) {
    const peer = new JsonLinePeer(this.executable, this.appServerArgs, {
      cwd: request.workspace.path,
    });
    const queue = eventQueue();
    const off = peer.onMessage(queue.push);
    const offFailure = peer.onFailure(queue.fail);
    let threadId;
    let turnId;
    let usage;
    try {
      await peer.request("initialize", {
        clientInfo: { name: "all-api", title: "All API", version: "0.5.1" },
        capabilities: { experimentalApi: true },
      });
      peer.notify("initialized", {});
      const overrides = request.profile.source === "managed" ? request.profile.overrides : {};
      const threadOverrides = { ...(overrides.thread ?? {}) };
      if (request.sessionId && request.profile.source === "local") {
        const { config } = await peer.request("config/read", {
          includeLayers: false,
          cwd: request.workspace.path,
        });
        // Local profiles follow this host's configuration even when the stored
        // thread originated on a host with another provider or model.
        threadOverrides.model = config.model;
        threadOverrides.modelProvider = config.model_provider;
      }
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
      request.onSession?.(threadId);
      const turn = await peer.request("turn/start", {
        threadId,
        input: toCodexInput(request.input),
        ...(overrides.turn ?? {}),
      });
      turnId = turn.turn.id;
      request.signal?.addEventListener("abort", () => {
        peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      }, { once: true });

      for await (const message of queue) {
        if (message.method === "item/agentMessage/delta") {
          yield { type: "text.delta", delta: message.params.delta };
        } else if (message.method === "thread/tokenUsage/updated"
          && message.params.turnId === turnId) {
          usage = codexUsage(message.params.tokenUsage.last);
        } else if (message.id !== undefined && typeof message.method === "string") {
          yield { type: "interaction", payload: message };
          yield { type: "interrupted", sessionId: threadId, ...(usage && { usage }) };
          return;
        } else if (message.method === "turn/completed" && message.params.turn.id === turnId) {
          if (message.params.turn.status === "completed") {
            yield { type: "completed", sessionId: threadId, ...(usage && { usage }) };
            return;
          }
          const error = new Error(
            message.params.turn.error?.message ?? `Codex turn ${message.params.turn.status}`,
          );
          error.code = `turn_${message.params.turn.status}`;
          throw error;
        } else {
          yield { type: "agent.event", payload: message };
        }
      }
    } finally {
      off();
      offFailure();
      queue.end();
      await peer.close();
    }
  }

  async openNative({ send, fail = () => {}, workspace, profile }) {
    const native = profile?.source === "managed" ? profile.overrides.native ?? {} : {};
    const peer = new JsonLinePeer(this.executable, native.args ?? this.appServerArgs, {
      cwd: workspace?.path,
      env: { ...process.env, ...(native.env ?? {}) },
    });
    const offRaw = peer.onRaw((frame) => send(frame, false));
    const offFailure = peer.onFailure(fail);
    return {
      receive: async (frame, isBinary) => peer.sendRaw(frame, isBinary),
      close: async () => {
        offRaw();
        offFailure();
        await peer.close();
      },
    };
  }
}

export class ClaudeAdapter {
  capabilities = CLAUDE_CAPABILITIES;
  native = Object.freeze({
    transport: "websocket-json",
    protocol: "claude-code-stream-json",
    protocolVersion: null,
    resumable: false,
    clientTools: true,
    workspaceFromFrames: false,
  });

  constructor({ executable = "claude", query = claudeQuery, nativeArgs } = {}) {
    this.executable = executable;
    this.query = query;
    this.nativeArgs = nativeArgs;
  }

  describe() {
    return executableDescription(this.executable);
  }

  async verifyStandard() {
    const description = await this.describe();
    if (this.standardVersion !== description.version) {
      this.standardVersion = description.version;
      this.standardCompatibility = verifyClaudeStandard(Promise.resolve(description));
    }
    return this.standardCompatibility;
  }

  async *run(request) {
    const overrides = request.profile.source === "managed" ? request.profile.overrides : {};
    const claudeOptions = { ...(overrides.options ?? {}) };
    const systemPrompt = claudeSystemPrompt(claudeOptions.systemPrompt, request.instructions);
    delete claudeOptions.systemPrompt;
    let interactiveRequest;
    let latestUsage;
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
        canUseTool: async (toolName, input, details) => {
          const { signal, ...metadata } = details;
          void signal;
          interactiveRequest = { toolName, input, ...metadata };
          return {
            behavior: "deny",
            message: "Interactive approval is unavailable on standard HTTP protocols; use native",
          };
        },
      },
    });
    let sessionId = request.sessionId;
    let announcedSession;
    for await (const message of execution) {
      sessionId = message.session_id ?? sessionId;
      if (sessionId && sessionId !== announcedSession) {
        announcedSession = sessionId;
        request.onSession?.(sessionId);
      }
      const messageUsage = message.message?.usage ?? message.usage;
      if (Number.isFinite(messageUsage?.input_tokens)
        && Number.isFinite(messageUsage?.output_tokens)) {
        latestUsage = {
          input_tokens: messageUsage.input_tokens,
          output_tokens: messageUsage.output_tokens,
        };
      }
      if (interactiveRequest) {
        yield { type: "interaction", payload: interactiveRequest };
        yield {
          type: "interrupted",
          sessionId,
          ...(latestUsage && { usage: latestUsage }),
        };
        return;
      }
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text") yield { type: "text.delta", delta: block.text };
          else if (block.type === "tool_use") yield { type: "agent.tool", payload: block };
          else yield { type: "agent.event", payload: { message, block } };
        }
      } else if (message.type === "result") {
        if (message.is_error || message.subtype !== "success") {
          const error = new Error(
            message.errors?.join("\n") || `Claude execution failed: ${message.subtype}`,
          );
          error.code = message.subtype;
          throw error;
        }
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
      } else {
        yield { type: "agent.event", payload: message };
      }
    }
    throw new Error("Claude Agent SDK ended without a result message");
  }

  async openNative({ send, fail = () => {}, workspace, profile }) {
    const native = profile.source === "managed" ? profile.overrides.native ?? {} : {};
    const peer = new JsonLinePeer(this.executable, native.args ?? this.nativeArgs ?? claudeNativeArgs(), {
      cwd: workspace?.path,
      env: { ...process.env, ...(native.env ?? {}), CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
    });
    const offRaw = peer.onRaw((frame) => send(frame, false));
    const offFailure = peer.onFailure(fail);
    return {
      receive: async (frame, isBinary) => peer.sendRaw(frame, isBinary),
      close: async () => {
        offRaw();
        offFailure();
        await peer.close();
      },
    };
  }
}

export class ConnectorAdapter {
  constructor(definition) {
    this.definition = definition;
    this.capabilities = definition.capabilities;
    this.native = definition.native ?? {
      transport: "websocket-json",
      protocol: "connector-jsonrpc",
      protocolVersion: "1",
      resumable: Boolean(definition.capabilities.continuation),
      clientTools: definition.capabilities.tools.includes("client"),
      workspaceFromFrames: false,
    };
  }

  async describe() {
    return { version: this.definition.version ?? null };
  }

  async verifyStandard() {
    return standardCompatibility({
      status: "unverified",
      reason: "Custom connectors are Native-only until independently certified",
    });
  }

  async *run(request) {
    const peer = new JsonLinePeer(this.definition.command, this.definition.args ?? [], {
      cwd: request.workspace.path,
      env: { ...process.env, ...(this.definition.env ?? {}) },
    });
    const queue = eventQueue();
    const off = peer.onMessage(queue.push);
    const offFailure = peer.onFailure(queue.fail);
    try {
      await peer.request("initialize", {
        protocolVersion: 1,
        client: { name: "all-api", version: "0.5.1" },
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
      offFailure();
      queue.end();
      await peer.close();
    }
  }

  async openNative({ send, fail = () => {}, workspace }) {
    const peer = new JsonLinePeer(this.definition.command, this.definition.args ?? [], {
      cwd: workspace?.path,
      env: { ...process.env, ...(this.definition.env ?? {}) },
    });
    const offRaw = peer.onRaw((frame) => send(frame, false));
    const offFailure = peer.onFailure(fail);
    return {
      receive: async (frame, isBinary) => peer.sendRaw(frame, isBinary),
      close: async () => {
        offRaw();
        offFailure();
        await peer.close();
      },
    };
  }
}

export function createDefaultRegistry(config) {
  const registry = new AgentRegistry()
    .register("codex", new CodexAdapter({ executable: config.executables?.codex }))
    .register("claude", new ClaudeAdapter({ executable: config.executables?.claude }));
  for (const [name, definition] of Object.entries(config.connectors)) {
    registry.register(name, new ConnectorAdapter(definition));
  }
  return registry;
}

function toCodexInput(input) {
  const result = [];
  for (const block of normalizeBlocks(input)) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
    else if (block.type === "image_url") result.push({ type: "image", url: block.url });
    else if (block.type === "local_image") result.push({ type: "localImage", path: block.path });
    else if (block.type === "file") throw new Error("Codex app-server does not support generic file input");
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

function codexUsage(value) {
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
  let failure;
  return {
    push(value) {
      const waiter = waiters.shift();
      waiter ? waiter.resolve({ value, done: false }) : values.push(value);
    },
    fail(error) {
      if (ended) return;
      ended = true;
      failure = error;
      values.length = 0;
      while (waiters.length) waiters.shift().reject(error);
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length) waiters.shift().resolve({ done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function rpcError(error) {
  const result = new Error(error.message ?? "Agent RPC error");
  result.code = error.code;
  result.data = error.data;
  return result;
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

function claudeNativeArgs() {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--setting-sources=user,project,local",
  ];
}

function executableDescription(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolve({ version: null }));
    child.once("close", (code) => resolve({
      version: code === 0 ? output.trim() || null : null,
    }));
    const timer = setTimeout(() => child.kill("SIGTERM"), 2_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
}

async function verifyCodexStandard(executable, descriptionPromise) {
  const description = await descriptionPromise;
  const version = semanticVersion(description.version);
  if (version !== CERTIFIED_CODEX_VERSION) {
    return standardCompatibility({
      status: "unverified",
      agent_version: version,
      reason: `Codex ${version ?? "unknown"} is not certified; expected ${CERTIFIED_CODEX_VERSION}`,
    });
  }
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-codex-schema-"));
  try {
    const generated = await runProcess(executable, [
      "app-server", "generate-json-schema", "--out", directory,
    ], 30_000);
    if (!generated.ok) {
      return standardCompatibility({
        status: "unverified",
        agent_version: version,
        reason: "Codex app-server schema generation failed",
      });
    }
    const [notifications, completed] = await Promise.all([
      readFile(path.join(directory, "ServerNotification.json"), "utf8"),
      readFile(path.join(directory, "v2", "TurnCompletedNotification.json"), "utf8"),
    ]);
    if (!notifications.includes('"turn/completed"')
      || !notifications.includes('"thread/tokenUsage/updated"')
      || !completed.includes('"failed"')
      || !completed.includes('"interrupted"')) {
      return standardCompatibility({
        status: "unverified",
        agent_version: version,
        reason: "Codex app-server schema does not match the certified protocol",
      });
    }
    return standardCompatibility({
      status: "verified",
      agent_version: version,
      evidence: "official_schema_and_real_sdk_e2e",
    });
  } catch (error) {
    return standardCompatibility({
      status: "unverified",
      agent_version: version,
      reason: `Codex protocol check failed: ${error.message}`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyClaudeStandard(descriptionPromise) {
  const description = await descriptionPromise;
  const version = semanticVersion(description.version);
  let sdkVersion;
  try {
    const manifest = JSON.parse(await readFile(
      new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url),
      "utf8",
    ));
    sdkVersion = manifest.version;
  } catch {
    sdkVersion = null;
  }
  if (!CERTIFIED_CLAUDE_VERSIONS.has(version) || sdkVersion !== CERTIFIED_CLAUDE_SDK_VERSION) {
    return standardCompatibility({
      status: "unverified",
      agent_version: version,
      sdk_version: sdkVersion,
      reason: `Claude ${version ?? "unknown"} / SDK ${sdkVersion ?? "unknown"} is not certified`,
    });
  }
  return standardCompatibility({
    status: "verified",
    agent_version: version,
    sdk_version: sdkVersion,
    evidence: "official_sdk_and_real_sdk_e2e",
  });
}

function standardCompatibility(result) {
  return {
    ...result,
    protocols: Object.fromEntries(
      ["chat_completions", "responses", "messages"].map((protocol) => [
        protocol,
        {
          status: result.status,
          ...(result.reason && { reason: result.reason }),
          ...(result.evidence && { evidence: result.evidence }),
        },
      ]),
    ),
  };
}

function semanticVersion(value) {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(value ?? "")?.[1] ?? null;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("close", (code) => resolve({ ok: code === 0, code, stderr }));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
}
