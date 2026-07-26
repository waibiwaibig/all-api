#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adminEndpoint, adminRequest, createAdminServer } from "./admin.mjs";
import { createDefaultRegistry } from "./agents.mjs";
import { ConfigStore, createApiKey } from "./core.mjs";
import {
  configureCloudflare,
  detectAgents,
  installAgent,
  restoreExposure,
  setAutostart,
  startExposure,
  stopExposure,
  updateAgent,
} from "./platform.mjs";
import { createAllApiServer } from "./server.mjs";

const cliPath = fileURLToPath(import.meta.url);
const dataDirectory = path.resolve(process.env.ALL_API_HOME ?? path.join(homedir(), ".all-api"));
const configPath = path.join(dataDirectory, "config.json");
const endpoint = adminEndpoint(dataDirectory);
const store = new ConfigStore(configPath);

if (process.argv[1] && path.resolve(process.argv[1]) === cliPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`all-api: ${error.message}`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [command = "help", subject, action] = positional;
  if (command === "help" || options.help) return printHelp();
  if (command === "init") return initialize(options);
  if (command === "serve") return serve();
  if (command === "up") return startBackground();
  if (command === "down") return output(await managementCall("server.shutdown"));
  if (command === "status") return status();
  if (command === "detect") return output(await detectAgents());

  if (command === "models") return output((await managementCall("catalog")).models);
  if (command === "workspaces") return output((await managementCall("catalog")).workspaces);
  if (command === "keys") return output(await managementCall("key.list"));
  if (command === "connectors") return output((await managementCall("catalog")).connectors);

  if (command === "model" && subject === "put") {
    const id = required(positional[2], "model id");
    const source = options.source ?? "local";
    return output(await managementCall("profile.put", {
      id,
      profile: {
        agent: required(options.agent, "--agent"),
        source,
        workspace: required(options.workspace, "--workspace"),
        ...(source === "managed"
          ? { overrides: jsonOption(options.overrides ?? "{}", "--overrides") }
          : {}),
      },
    }));
  }
  if (command === "model" && subject === "delete") {
    return output(await managementCall("profile.delete", { id: required(positional[2], "model id") }));
  }
  if (command === "workspace" && subject === "add") {
    return output(await managementCall("workspace.put", {
      id: required(positional[2], "workspace id"),
      workspace: {
        path: path.resolve(required(positional[3], "workspace path")),
        ...(options.label ? { label: options.label } : {}),
      },
    }));
  }
  if (command === "workspace" && subject === "remove") {
    return output(await managementCall("workspace.delete", {
      id: required(positional[2], "workspace id"),
    }));
  }
  if (command === "key" && subject === "create") {
    const catalog = await managementCall("catalog");
    const kind = options.type ?? "access";
    const workspaces = csv(options.workspaces) ?? catalog.workspaces.map((workspace) => workspace.id);
    return output(await managementCall("key.create", {
      kind,
      name: required(positional[2], "key name"),
      ...(kind === "access" ? {
        models: csv(options.models) ?? catalog.models.map((model) => model.id),
        workspaces,
        defaultWorkspace: options["default-workspace"] ?? workspaces[0],
      } : {}),
    }));
  }
  if (command === "key" && subject === "revoke") {
    return output(await managementCall("key.revoke", { id: required(positional[2], "key id") }));
  }
  if (command === "connector" && subject === "put") {
    return output(await managementCall("connector.put", {
      id: required(positional[2], "connector id"),
      connector: {
        command: path.resolve(required(options.command, "--command")),
        args: jsonOption(options.args ?? "[]", "--args"),
        capabilities: jsonOption(required(options.capabilities, "--capabilities"), "--capabilities"),
        ...(options.env ? { env: jsonOption(options.env, "--env") } : {}),
        ...(options.version ? { version: options.version } : {}),
        ...(options.native ? { native: jsonOption(options.native, "--native") } : {}),
      },
    }));
  }
  if (command === "connector" && subject === "delete") {
    return output(await managementCall("connector.delete", {
      id: required(positional[2], "connector id"),
    }));
  }
  if (command === "agent" && subject === "detect") return output(await detectAgents());
  if (command === "agent" && subject === "install") {
    return output(await installAgent(required(positional[2], "agent name")));
  }
  if (command === "agent" && subject === "update") {
    return output(await updateAgent(required(positional[2], "agent name")));
  }
  if (command === "autostart" && ["on", "off"].includes(subject)) {
    return output(await setAutostart({
      enabled: subject === "on",
      dataDirectory,
      cliPath,
    }));
  }
  if (command === "expose") return expose(subject, action, options);
  throw new Error(`Unknown command. Run "all-api help".`);
}

async function initialize(options) {
  try {
    await access(configPath);
    throw new Error(`${configPath} already exists; delete it explicitly to replace the configuration`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const agents = await detectAgents();
  const installed = agents.filter((agent) => agent.installed);
  const models = Object.fromEntries(installed.map((agent) => [
    agent.name,
    { agent: agent.name, source: "local", workspace: "default" },
  ]));
  const workspacePath = path.resolve(options.workspace ?? process.cwd());
  const config = {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: numberOption(options.port, 8787),
      maxConcurrent: 4,
      maxNativeConnections: 8,
      maxNativeFrameBytes: 1_048_576,
      maxNativeBufferedBytes: 4_194_304,
      responseRetentionDays: 30,
      responsesIncludeProcessEvents: true,
    },
    models,
    workspaces: { default: { path: workspacePath, label: path.basename(workspacePath) } },
    keys: {},
    connectors: {},
  };
  let token;
  if (installed.length) {
    const created = await createApiKey({
      kind: "access",
      name: "default",
      models: Object.keys(models),
      workspaces: ["default"],
      defaultWorkspace: "default",
    });
    token = created.token;
    config.keys[created.record.id] = created.record;
  }
  await store.save(config);
  output({
    initialized: configPath,
    agents,
    models: Object.keys(models),
    workspace: workspacePath,
    ...(token ? { accessKey: token } : {
      warning: "No supported Agent is installed; install one, add its model, then create a key",
    }),
  });
}

async function serve() {
  let config = await store.load();
  const registry = createDefaultRegistry(config);
  const app = await createAllApiServer({ config, registry, dataDirectory });
  let closing = false;
  let admin;

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await admin?.close();
    await app.close();
  };
  const actions = {
    "agent.detect": () => detectAgents(),
    "agent.install": ({ name }) => {
      const active = app.activity();
      if (active.standard || active.native) throw new Error("Stop active Agent sessions before installing");
      return installAgent(name);
    },
    "agent.update": ({ name }) => {
      const active = app.activity();
      if (active.standard || active.native) throw new Error("Stop active Agent sessions before updating");
      return updateAgent(name);
    },
    "autostart.set": ({ enabled }) => setAutostart({
      enabled: Boolean(enabled),
      dataDirectory,
      cliPath,
    }),
    "exposure.cloudflare.configure": (params, current) => configureCloudflare({
      dataDirectory,
      name: params.name,
      hostname: params.hostname,
      localPort: current.server.port,
    }),
    "exposure.start": (params, current) => startExposure(params.provider, {
      ...params,
      dataDirectory,
      localPort: current.server.port,
    }),
    "exposure.stop": (params) => stopExposure(params.provider, { ...params, dataDirectory }),
    "server.shutdown": () => {
      setImmediate(() => shutdown().then(() => process.exit(0)));
      return { stopping: true };
    },
  };
  admin = await createAdminServer({
    endpoint,
    getConfig: () => config,
    async saveConfig(next) {
      await store.save(next);
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, structuredClone(next));
    },
    onKeyRevoked: (keyId) => app.revokeKey(keyId),
    actions,
  });
  const address = await app.listen();
  console.log(`All API listening at http://${address.address}:${address.port}`);
  console.log(`Local management: ${endpoint}`);
  restoreExposure({ dataDirectory, localPort: address.port }).catch((error) => {
    console.error(`All API could not restore public exposure: ${error.message}`);
  });
  process.once("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown().then(() => process.exit(0)));
}

async function startBackground() {
  await store.load();
  try {
    const health = await fetchLocalHealth();
    if (health.status === "ok") return output({ running: true, alreadyRunning: true });
  } catch {}
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDirectory, "server.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [cliPath, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  await writeFile(path.join(dataDirectory, "server.pid"), `${child.pid}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    try {
      if ((await fetchLocalHealth()).status === "ok") {
        return output({ running: true, pid: child.pid, log: logPath });
      }
    } catch {}
  }
  throw new Error(`Server did not become healthy; inspect ${logPath}`);
}

async function status() {
  const config = await store.load();
  let server = { running: false };
  try {
    server = { running: true, ...(await fetchLocalHealth(config)) };
  } catch {}
  output({ server, agents: await detectAgents(), config: configPath });
}

async function expose(provider, action, options) {
  if (provider === "direct" && ["on", "off"].includes(action)) {
    return output(await managementCall("server.update", {
      host: action === "on" ? "0.0.0.0" : "127.0.0.1",
    }));
  }
  if (provider === "cloudflare" && action === "setup") {
    const config = await store.load();
    return output(await configureCloudflare({
      dataDirectory,
      name: options.name ?? "all-api",
      hostname: required(options.hostname, "--hostname"),
      localPort: config.server.port,
    }));
  }
  if (["cloudflare", "tailscale", "relay"].includes(provider) && action === "start") {
    const config = await store.load();
    return output(await startExposure(provider, {
      dataDirectory,
      localPort: config.server.port,
      name: options.name,
      configPath: options.config,
      host: options.host,
      remotePort: options["remote-port"] ? numberOption(options["remote-port"]) : undefined,
    }));
  }
  if (["cloudflare", "tailscale", "relay"].includes(provider) && action === "stop") {
    return output(await stopExposure(provider, { dataDirectory }));
  }
  throw new Error("Unknown exposure command");
}

async function managementCall(method, params, options) {
  try {
    return await adminRequest(endpoint, method, params, options);
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error.code)) throw error;
  }
  let config = await store.load();
  const actions = {
    "agent.detect": () => detectAgents(),
    "agent.install": ({ name }) => installAgent(name),
    "agent.update": ({ name }) => updateAgent(name),
    "autostart.set": ({ enabled }) => setAutostart({
      enabled: Boolean(enabled), dataDirectory, cliPath,
    }),
    "exposure.cloudflare.configure": (value, current) => configureCloudflare({
      dataDirectory,
      name: value.name,
      hostname: value.hostname,
      localPort: current.server.port,
    }),
    "exposure.start": (value, current) => startExposure(value.provider, {
      ...value, dataDirectory, localPort: current.server.port,
    }),
    "exposure.stop": (value) => stopExposure(value.provider, { ...value, dataDirectory }),
  };
  const local = await createAdminServer({
    endpoint,
    getConfig: () => config,
    async saveConfig(next) {
      await store.save(next);
      config = next;
    },
    actions,
  });
  try {
    return await adminRequest(endpoint, method, params, options);
  } finally {
    await local.close();
  }
}

async function fetchLocalHealth(config) {
  const current = config ?? await store.load();
  const response = await fetch(`http://127.0.0.1:${current.server.port}/health`, {
    signal: AbortSignal.timeout(500),
  });
  if (!response.ok) throw new Error("Health check failed");
  return response.json();
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 0) {
      options[value.slice(2, equals)] = value.slice(equals + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[value.slice(2)] = argv[++index];
    } else {
      options[value.slice(2)] = true;
    }
  }
  return { positional, options };
}

function printHelp() {
  console.log(`All API — expose local Agents through standard and native protocols

Setup and service:
  all-api init [--workspace PATH] [--port 8787]
  all-api up | serve | status | down
  all-api autostart on|off

Configuration (local management socket only):
  all-api models | model put ID --agent NAME --workspace ID
      [--source local|managed] [--overrides JSON]
  all-api model delete ID
  all-api workspaces | workspace add ID PATH [--label TEXT] | workspace remove ID
  all-api keys | key create NAME [--type access|native]
      [--models a,b] [--workspaces x,y] [--default-workspace ID]
  all-api connectors | connector put ID --command PATH --capabilities JSON
      [--args JSON] [--env JSON] [--version TEXT] [--native JSON]
  all-api connector delete ID

Agents and exposure:
  all-api agent detect|install|update [codex|claude]
  all-api expose cloudflare setup --hostname api.example.com [--name all-api]
  all-api expose cloudflare|tailscale start|stop
  all-api expose relay start --host user@example.com --remote-port 8787
  all-api expose direct on|off

Public protocols:
  POST /v1/chat/completions   POST /v1/responses
  POST /v1/messages           GET/POST /v1/files
  WS   /v1/native/sessions    GET /allapi/v1/catalog
`);
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
  return value;
}

function csv(value) {
  if (value === undefined) return undefined;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function jsonOption(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function numberOption(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

function required(value, label) {
  if (value === undefined || value === true || value === "") throw new Error(`${label} is required`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
