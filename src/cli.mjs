#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = join(homedir(), ".all-api");
const DEFAULT_CONFIG = join(DEFAULT_DIR, "config.json");
const DEFAULT_PORT = 4011;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_AGENT_TYPES = new Set(["codex", "claude"]);
const localAgentRuns = new Map();

class HttpError extends Error {
  constructor(status, message, type = "server_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function usage() {
  console.log(`all-api

Usage:
  all-api init [--config FILE] [--workspace DIR]
  all-api setup [--config FILE] [--workspace DIR] [--host HOST] [--port PORT] [--yes]
  all-api up [--config FILE] [--host HOST] [--port PORT]
  all-api stop [--config FILE]
  all-api detect
  all-api key create [--config FILE] [--models MODEL,MODEL]

Examples:
  all-api init --workspace /path/to/repo
  all-api setup
  all-api up
  all-api stop
  all-api key create --models codex-local,claude-code
`);
}

function argValue(args, name, fallback = undefined) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function randomKey(prefix = "sk-allapi") {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function saveConfig(configPath, config) {
  ensureDir(dirname(configPath));
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function loadConfig(configPath) {
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function commandExists(command) {
  return new Promise((resolveExists) => {
    const child = spawn("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolveExists(code === 0));
    child.on("error", () => resolveExists(false));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolveRun) => {
    if (options.signal?.aborted) {
      resolveRun({ ok: false, code: null, stdout: "", stderr: "Aborted", timedOut: false, aborted: true });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let settled = false;
    let killTimer = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      cleanupOwnedProcessGroup(child, timedOut || aborted ? "SIGKILL" : "SIGTERM");
      resolveRun(result);
    };

    const stopChild = (reason) => {
      if (stopping) return;
      stopping = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 2000);
      killTimer.unref();
    };

    const onAbort = () => stopChild("abort");
    timer = setTimeout(() => {
      stopChild("timeout");
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr: String(error), timedOut, aborted });
    });
    child.on("exit", (code) => {
      const interrupted = timedOut || aborted;
      finish({
        ok: code === 0 && !interrupted,
        code,
        stdout,
        stderr: aborted && !stderr ? "Aborted" : stderr,
        timedOut,
        aborted,
      });
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function terminateChild(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  signalOwnedProcessGroup(child.pid, signal);
}

function cleanupOwnedProcessGroup(child, signal) {
  if (!child.pid) return;
  signalOwnedProcessGroup(child.pid, signal, { fallbackToPid: false });
}

function signalOwnedProcessGroup(pid, signal, options = {}) {
  try {
    process.kill(-pid, signal);
  } catch {
    if (options.fallbackToPid === false) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function detectAdapters() {
  const [codex, claude] = await Promise.all([commandExists("codex"), commandExists("claude")]);
  const openclaw = await probeOpenAIEndpoint("http://127.0.0.1:18789/v1");
  const hermes = await probeOpenAIEndpoint("http://127.0.0.1:8642/v1");

  return {
    codex: { available: codex, command: "codex" },
    claude: { available: claude, command: "claude" },
    openclaw: { available: openclaw, baseUrl: "http://127.0.0.1:18789/v1" },
    hermes: { available: hermes, baseUrl: "http://127.0.0.1:8642/v1" },
  };
}

function probeOpenAIEndpoint(baseUrl) {
  return new Promise((resolveProbe) => {
    const req = http.request(`${baseUrl}/models`, { method: "GET", timeout: 800 }, (res) => {
      res.resume();
      resolveProbe(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

async function buildInitialConfig(args) {
  const detected = await detectAdapters();
  const workspace = resolve(argValue(args, "--workspace", process.cwd()));
  const models = [];

  if (detected.codex.available) {
    models.push({
      id: "codex-local",
      type: "codex",
      command: "codex",
      workspace,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxConcurrent: 1,
      enabled: true,
    });
  }

  if (detected.claude.available) {
    models.push({
      id: "claude-code",
      type: "claude",
      command: "claude",
      workspace,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxConcurrent: 1,
      enabled: true,
    });
  }

  if (detected.openclaw.available) {
    models.push({
      id: "openclaw",
      type: "openai-compatible",
      baseUrl: detected.openclaw.baseUrl,
      apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN",
      upstreamModel: "openclaw/default",
      enabled: true,
    });
  }

  if (detected.hermes.available) {
    models.push({
      id: "hermes",
      type: "openai-compatible",
      baseUrl: detected.hermes.baseUrl,
      apiKeyEnv: "HERMES_API_SERVER_KEY",
      upstreamModel: "hermes-agent",
      enabled: true,
    });
  }

  const adminKey = randomKey("sk-allapi-admin");
  return {
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    keys: [
      {
        name: "admin",
        keyHash: sha256(adminKey),
        models: ["*"],
        createdAt: new Date().toISOString(),
      },
    ],
    models,
    printedKeys: { admin: adminKey },
  };
}

async function cmdInit(args) {
  const configPath = resolve(argValue(args, "--config", DEFAULT_CONFIG));
  if (existsSync(configPath) && !hasArg(args, "--force")) {
    console.error(`Config already exists: ${configPath}`);
    console.error("Use --force to overwrite.");
    process.exitCode = 1;
    return;
  }

  const config = await buildInitialConfig(args);
  const adminKey = config.printedKeys.admin;
  delete config.printedKeys;
  saveConfig(configPath, config);

  console.log(`Created ${configPath}`);
  printEndpoint(config, adminKey);
}

async function cmdSetup(args) {
  const configPath = resolve(argValue(args, "--config", DEFAULT_CONFIG));
  const nonInteractive = hasArg(args, "--yes") || hasArg(args, "-y") || !process.stdin.isTTY;
  let config = loadConfig(configPath);
  let generatedKey = null;

  if (config && !nonInteractive) {
    const keep = await ask(`Use existing config at ${configPath}?`, "Y");
    if (!/^n/i.test(keep)) {
      config.host = argValue(args, "--host", config.host ?? "127.0.0.1");
      config.port = Number(argValue(args, "--port", config.port ?? DEFAULT_PORT));
      if (!(await ensureDaemon(configPath, config))) return;
      printEndpoint(config, null);
      return;
    }
    config = null;
  }

  if (!config) {
    const defaults = {
      workspace: resolve(argValue(args, "--workspace", process.cwd())),
      host: argValue(args, "--host", "127.0.0.1"),
      port: String(argValue(args, "--port", DEFAULT_PORT)),
    };

    const workspace = nonInteractive
      ? defaults.workspace
      : resolve(await ask("Workspace directory", defaults.workspace));
    const host = nonInteractive ? defaults.host : await ask("Host", defaults.host);
    const port = Number(nonInteractive ? defaults.port : await ask("Port", defaults.port));

    config = await buildInitialConfig(["--workspace", workspace]);
    generatedKey = config.printedKeys.admin;
    delete config.printedKeys;
    config.host = host;
    config.port = port;
    saveConfig(configPath, config);
    console.log(`Created ${configPath}`);
  }

  if (!(await ensureDaemon(configPath, config))) return;
  printEndpoint(config, generatedKey);
}

async function ensureDaemon(configPath, config) {
  if (await isServerHealthy(config)) return true;

  const pidPath = pidFileForConfig(configPath);
  const oldPid = readPid(pidPath);
  if (oldPid && isProcessRunning(oldPid)) {
    console.error(`A process is already recorded for this config: ${oldPid}`);
    console.error(`If it is stale, remove ${pidPath}`);
    process.exitCode = 1;
    return false;
  }

  ensureDir(dirname(pidPath));
  const child = spawn(process.execPath, [
    realpathSync(fileURLToPath(import.meta.url)),
    "up",
    "--config",
    configPath,
    "--host",
    config.host,
    "--port",
    String(config.port),
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

  const ready = await waitForHealth(config, 5000);
  if (!ready) {
    console.error("Server did not become ready within 5 seconds.");
    console.error(`PID file: ${pidPath}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function waitForHealth(config, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isServerHealthy(config)) return true;
    await sleep(100);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isServerHealthy(config) {
  return new Promise((resolveHealth) => {
    const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const req = http.request(`http://${host}:${config.port}/health`, { method: "GET", timeout: 500 }, (res) => {
      res.resume();
      resolveHealth(res.statusCode === 200);
    });
    req.on("error", () => resolveHealth(false));
    req.on("timeout", () => {
      req.destroy();
      resolveHealth(false);
    });
    req.end();
  });
}

function pidFileForConfig(configPath) {
  return join(dirname(configPath), `server-${sha256(resolve(configPath)).slice(0, 12)}.pid`);
}

function readPid(pidPath) {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ask(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [${defaultValue}]: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function cmdDetect() {
  const detected = await detectAdapters();
  console.log(JSON.stringify(detected, null, 2));
}

async function cmdKeyCreate(args) {
  const configPath = resolve(argValue(args, "--config", DEFAULT_CONFIG));
  const config = loadConfig(configPath);
  if (!config) {
    console.error(`Missing config: ${configPath}`);
    process.exitCode = 1;
    return;
  }

  const models = argValue(args, "--models", "*").split(",").map((m) => m.trim()).filter(Boolean);
  const key = randomKey();
  config.keys.push({
    name: argValue(args, "--name", `key-${config.keys.length + 1}`),
    keyHash: sha256(key),
    models,
    createdAt: new Date().toISOString(),
  });
  saveConfig(configPath, config);
  console.log(key);
}

async function cmdUp(args) {
  const configPath = resolve(argValue(args, "--config", DEFAULT_CONFIG));
  let config = loadConfig(configPath);
  let generatedKey = null;
  if (!config) {
    config = await buildInitialConfig(args);
    generatedKey = config.printedKeys.admin;
    delete config.printedKeys;
    saveConfig(configPath, config);
  }

  config.host = argValue(args, "--host", config.host ?? "127.0.0.1");
  config.port = Number(argValue(args, "--port", config.port ?? DEFAULT_PORT));
  startServer(config);
  printEndpoint(config, generatedKey);
}

async function cmdStop(args) {
  const configPath = resolve(argValue(args, "--config", DEFAULT_CONFIG));
  const pidPath = pidFileForConfig(configPath);
  const pid = readPid(pidPath);
  if (!pid) {
    console.log("No all-api server PID found.");
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
  rmSync(pidPath, { force: true });
  console.log(`Stopped all-api server ${pid}.`);
}

function printEndpoint(config, key) {
  const hostForPrint = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log("");
  console.log("OpenAI-compatible endpoint:");
  console.log(`  http://${hostForPrint}:${config.port}/v1`);
  if (key) {
    console.log("");
    console.log("API key:");
    console.log(`  ${key}`);
  }
  console.log("");
  console.log("Models:");
  for (const model of config.models.filter((m) => m.enabled)) {
    console.log(`  ${model.id}`);
  }
  console.log("");
}

function startServer(config) {
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, config);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, error.status ?? 500, {
        error: {
          message: error?.message ?? "Internal server error",
          type: error?.type ?? "server_error",
        },
      });
    }
  });

  server.listen(config.port, config.host, () => {});
}

async function route(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const auth = authenticate(req, config);
  if (!auth.ok) {
    sendJson(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    sendJson(res, 200, {
      object: "list",
      data: allowedModels(config, auth.key).map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "all-api",
      })),
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    const body = await readJsonBody(req);
    const model = config.models.find((m) => m.enabled && m.id === body.model);
    if (!model) {
      sendJson(res, 404, { error: { message: `Unknown model: ${body.model}`, type: "invalid_request_error" } });
      return;
    }
    if (!keyAllowsModel(auth.key, model.id)) {
      sendJson(res, 403, { error: { message: `API key cannot access model: ${model.id}`, type: "permission_error" } });
      return;
    }

    const requestLifetime = createRequestLifetime(req, res);
    let result;
    try {
      result = await complete(model, body, { signal: requestLifetime.signal });
    } finally {
      requestLifetime.cleanup();
    }
    if (requestLifetime.signal.aborted || res.destroyed || res.writableEnded) return;
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
}

function createRequestLifetime(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", abort);
  res.on("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

function authenticate(req, config) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false };
  const hash = sha256(match[1]);
  const found = config.keys.find((key) => safeEqual(key.keyHash, hash));
  if (!found) return { ok: false };
  return { ok: true, key: found };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function allowedModels(config, key) {
  return config.models.filter((model) => model.enabled && keyAllowsModel(key, model.id));
}

function keyAllowsModel(key, modelId) {
  return key.models.includes("*") || key.models.includes(modelId);
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        rejectBody(new Error("Invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

async function complete(model, body, options = {}) {
  const release = LOCAL_AGENT_TYPES.has(model.type) ? acquireLocalAgentSlot(model) : null;
  try {
    if (model.type === "codex") return await completeWithCodex(model, body, options);
    if (model.type === "claude") return await completeWithClaude(model, body, options);
    if (model.type === "openai-compatible") return await completeWithOpenAICompatible(model, body, options);
  } finally {
    release?.();
  }
  throw new Error(`Unsupported model type: ${model.type}`);
}

function acquireLocalAgentSlot(model) {
  const maxConcurrent = Math.max(1, Number(model.maxConcurrent ?? 1) || 1);
  const current = localAgentRuns.get(model.id) ?? 0;
  if (current >= maxConcurrent) {
    throw new HttpError(
      429,
      `${model.id} is busy. all-api keeps local ${model.type} runs to ${maxConcurrent} at a time so repeated hotkeys do not pile up agent processes.`,
      "rate_limit_error",
    );
  }
  localAgentRuns.set(model.id, current + 1);
  return () => {
    const next = (localAgentRuns.get(model.id) ?? 1) - 1;
    if (next > 0) localAgentRuns.set(model.id, next);
    else localAgentRuns.delete(model.id);
  };
}

async function completeWithCodex(model, body, options = {}) {
  const prompt = messagesToPrompt(body.messages);
  const result = await run(model.command ?? "codex", [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    model.workspace ?? process.cwd(),
    prompt,
  ], { timeoutMs: model.timeoutMs, signal: options.signal });

  if (!result.ok) throw new Error(result.stderr || `codex exited with code ${result.code}`);
  return chatCompletion(body.model, extractCodexText(result.stdout));
}

async function completeWithClaude(model, body, options = {}) {
  const prompt = messagesToPrompt(body.messages);
  const result = await run(model.command ?? "claude", [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
  ], {
    cwd: model.workspace ?? process.cwd(),
    timeoutMs: model.timeoutMs,
    signal: options.signal,
  });

  if (!result.ok) throw new Error(result.stderr || `claude exited with code ${result.code}`);
  return chatCompletion(body.model, extractClaudeText(result.stdout));
}

async function completeWithOpenAICompatible(model, body, options = {}) {
  const url = new URL(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`);
  const upstreamBody = {
    ...body,
    model: model.upstreamModel ?? body.model,
  };
  delete upstreamBody.user;

  const headers = {
    "content-type": "application/json",
  };
  const apiKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : model.apiKey;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `upstream returned ${response.status}`);
  return JSON.parse(text);
}

function messagesToPrompt(messages = []) {
  return messages.map((message) => {
    const role = message.role ?? "user";
    const content = normalizeContent(message.content);
    return `${role.toUpperCase()}:\n${content}`;
  }).join("\n\n");
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      return JSON.stringify(part);
    }).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function extractCodexText(stdout) {
  let lastText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const candidate = findText(event);
      if (candidate) lastText = candidate;
    } catch {
      lastText = line;
    }
  }
  return lastText || stdout.trim();
}

function extractClaudeText(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? parsed.response ?? parsed.content ?? findText(parsed) ?? stdout.trim();
  } catch {
    return stdout.trim();
  }
}

function findText(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (typeof value.message === "string") return value.message;
  if (Array.isArray(value.content)) {
    const text = value.content.map(findText).filter(Boolean).join("\n");
    if (text) return text;
  }
  for (const item of Object.values(value)) {
    const text = Array.isArray(item)
      ? item.map(findText).filter(Boolean).join("\n")
      : findText(item);
    if (text) return text;
  }
  return "";
}

function chatCompletion(model, content) {
  return {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export {
  acquireLocalAgentSlot,
  chatCompletion,
  extractClaudeText,
  extractCodexText,
  run,
  messagesToPrompt,
};

async function main(args = process.argv.slice(2)) {
  const command = args[0];

  if (!command || hasArg(args, "--help") || hasArg(args, "-h")) {
    usage();
  } else if (command === "init") {
    await cmdInit(args.slice(1));
  } else if (command === "setup") {
    await cmdSetup(args.slice(1));
  } else if (command === "up") {
    await cmdUp(args.slice(1));
  } else if (command === "stop") {
    await cmdStop(args.slice(1));
  } else if (command === "detect") {
    await cmdDetect();
  } else if (command === "key" && args[1] === "create") {
    await cmdKeyCreate(args.slice(2));
  } else {
    usage();
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  await main();
}
