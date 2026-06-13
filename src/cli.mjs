#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

function usage() {
  console.log(`all-api

Usage:
  all-api init [--config FILE] [--workspace DIR]
  all-api setup [--config FILE] [--workspace DIR] [--host HOST] [--port PORT] [--yes]
  all-api up [--config FILE] [--host HOST] [--port PORT]
  all-api detect
  all-api key create [--config FILE] [--models MODEL,MODEL]

Examples:
  all-api init --workspace /path/to/repo
  all-api setup
  all-api up
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, "SIGTERM");
      setTimeout(() => terminateChild(child, "SIGKILL"), 2000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ ok: false, code: null, stdout, stderr: String(error), timedOut });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ ok: code === 0, code, stdout, stderr, timedOut });
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function terminateChild(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
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
      startServer(config);
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

  startServer(config);
  printEndpoint(config, generatedKey);
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
      sendJson(res, 500, {
        error: {
          message: error?.message ?? "Internal server error",
          type: "server_error",
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

  if (req.method === "GET" && url.pathname === "/v1/models") {
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

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
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

    const result = await complete(model, body);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
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

async function complete(model, body) {
  if (model.type === "codex") return completeWithCodex(model, body);
  if (model.type === "claude") return completeWithClaude(model, body);
  if (model.type === "openai-compatible") return completeWithOpenAICompatible(model, body);
  throw new Error(`Unsupported model type: ${model.type}`);
}

async function completeWithCodex(model, body) {
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
  ], { timeoutMs: model.timeoutMs });

  if (!result.ok) throw new Error(result.stderr || `codex exited with code ${result.code}`);
  return chatCompletion(body.model, extractCodexText(result.stdout));
}

async function completeWithClaude(model, body) {
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
  });

  if (!result.ok) throw new Error(result.stderr || `claude exited with code ${result.code}`);
  return chatCompletion(body.model, extractClaudeText(result.stdout));
}

async function completeWithOpenAICompatible(model, body) {
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
  chatCompletion,
  extractClaudeText,
  extractCodexText,
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
