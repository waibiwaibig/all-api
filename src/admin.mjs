import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { createConnection, createServer } from "node:net";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { createApiKey, validateConfig } from "./core.mjs";

export function adminEndpoint(dataDirectory) {
  if (process.platform === "win32") {
    const id = crypto.createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\all-api-${id}`;
  }
  return path.join(dataDirectory, "admin.sock");
}

export async function createAdminServer({
  endpoint,
  getConfig,
  saveConfig,
  actions = {},
  onKeyRevoked = async () => {},
}) {
  if (process.platform !== "win32") await rm(endpoint, { force: true });
  let operations = Promise.resolve();
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      const operation = operations.catch(() => {}).then(() => handle(line));
      operations = operation;
      operation.then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error) => socket.end(`${JSON.stringify({
          ok: false,
          error: { message: error.message, code: error.code ?? "admin_error" },
        })}\n`),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);

  async function handle(line) {
    const request = JSON.parse(line);
    if (!request || typeof request.method !== "string") throw new Error("Invalid management request");
    const params = request.params ?? {};
    const config = getConfig();
    if (request.method === "catalog") return managementCatalog(config);
    if (request.method === 'agent.executable') {
      if (!['codex', 'claude'].includes(params.name) || !path.isAbsolute(params.path ?? '')) throw new Error('Require a built-in agent and absolute executable path');
      const next = structuredClone(config);
      next.executables = { ...next.executables, [params.name]: params.path };
      await persist(next);
      return { agent: params.name, executable: params.path, restartRequired: true };
    }
    if (request.method === "key.list") return publicKeys(config);
    if (request.method === 'secretary.init') {
      if (config.secretary) throw new Error('Secretary already configured; preserve its identity and connection file');
      requireEntry(config.models, params.model, 'model');
      requireEntry(config.workspaces, params.workspace, 'workspace');
      const created = await createApiKey({ kind: 'access', name: 'Secretary connection', models: [params.model], workspaces: [params.workspace], defaultWorkspace: params.workspace });
      const next = structuredClone(config);
      next.keys[created.record.id] = created.record;
      next.secretary = {
        id: randomUUID(),
        name: params.name ?? '秘书',
        model: params.model,
        workspace: params.workspace,
        keyId: created.record.id,
        url: (params.url ?? `http://127.0.0.1:${config.server.port}`).replace(/\/$/, ''),
      };
      await persist(next);
      return { version: 1, protocol: 'a2a/1.0', id: next.secretary.id, name: next.secretary.name, agentCardUrl: next.secretary.url + '/.well-known/agent-card.json', token: created.token };
    }

    if (request.method === "key.create") {
      const kind = params.kind ?? "access";
      if (kind === "access") {
        assertKnown(params.models, config.models, "model");
        assertKnown(params.workspaces, config.workspaces, "workspace");
        if (!params.workspaces.includes(params.defaultWorkspace)) {
          throw new Error("defaultWorkspace must be one of the granted workspaces");
        }
      } else if (kind !== "native") {
        throw new Error("key kind must be access or native");
      }
      const created = await createApiKey({ ...params, kind });
      const next = structuredClone(config);
      next.keys[created.record.id] = created.record;
      await persist(next);
      return { token: created.token, ...publicKey(created.record) };
    }
    if (request.method === "key.revoke") {
      requireEntry(config.keys, params.id, "key");
      const next = structuredClone(config);
      delete next.keys[params.id];
      await persist(next);
      await onKeyRevoked(params.id);
      return { revoked: params.id };
    }
    if (request.method === "profile.put") {
      const next = structuredClone(config);
      next.models[requiredId(params.id)] = params.profile;
      await persist(next);
      return { id: params.id, ...params.profile };
    }
    if (request.method === "profile.delete") {
      requireEntry(config.models, params.id, "model");
      const owner = Object.values(config.keys).find((key) => key.kind === "access"
        && key.models.includes(params.id));
      if (owner) throw new Error(`Model "${params.id}" is still granted to key "${owner.name}"`);
      const next = structuredClone(config);
      delete next.models[params.id];
      await persist(next);
      return { deleted: params.id };
    }
    if (request.method === "workspace.put") {
      const next = structuredClone(config);
      next.workspaces[requiredId(params.id)] = params.workspace;
      await persist(next);
      return { id: params.id, ...params.workspace };
    }
    if (request.method === "workspace.delete") {
      requireEntry(config.workspaces, params.id, "workspace");
      const owner = Object.values(config.keys).find((key) => key.kind === "access"
        && key.workspaces.includes(params.id));
      if (owner) throw new Error(`Workspace "${params.id}" is still granted to key "${owner.name}"`);
      const model = Object.entries(config.models).find(([, profile]) => profile.workspace === params.id);
      if (model) throw new Error(`Workspace "${params.id}" is still used by model "${model[0]}"`);
      const next = structuredClone(config);
      delete next.workspaces[params.id];
      await persist(next);
      return { deleted: params.id };
    }
    if (request.method === "connector.put") {
      const next = structuredClone(config);
      next.connectors[requiredId(params.id)] = params.connector;
      await persist(next);
      return { id: params.id, ...params.connector };
    }
    if (request.method === "connector.delete") {
      if (Object.values(config.models).some((model) => model.agent === params.id)) {
        throw new Error(`Connector "${params.id}" is still used by a model`);
      }
      const next = structuredClone(config);
      delete next.connectors[params.id];
      await persist(next);
      return { deleted: params.id };
    }
    if (request.method === "server.update") {
      const next = structuredClone(config);
      next.server = { ...next.server, ...params };
      await persist(next);
      return next.server;
    }
    const action = actions[request.method];
    if (action) return action(params, config);
    throw new Error(`Unknown management method: ${request.method}`);
  }

  async function persist(config) {
    validateConfig(config);
    await saveConfig(config);
  }

  return {
    server,
    endpoint,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== "win32") await rm(endpoint, { force: true });
    },
  };
}

export function adminRequest(endpoint, method, params = {}, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let body = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Management request timed out: ${method}`));
    }, timeoutMs);
    timer.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ method, params })}\n`);
    });
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("error", finishReject);
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(body);
        response.ok ? resolve(response.result) : reject(Object.assign(
          new Error(response.error?.message ?? "Management request failed"),
          { code: response.error?.code },
        ));
      } catch (error) {
        reject(error);
      }
    });

    function finishReject(error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function managementCatalog(config) {
  return {
    server: config.server,
    models: Object.entries(config.models).map(([id, profile]) => ({ id, ...profile })),
    workspaces: Object.entries(config.workspaces).map(([id, workspace]) => ({ id, ...workspace })),
    keys: publicKeys(config),
    connectors: Object.entries(config.connectors).map(([id, connector]) => ({
      id,
      ...connector,
      env: connector.env ? Object.keys(connector.env) : [],
    })),
  };
}

function publicKeys(config) {
  return Object.entries(config.keys).map(([id, record]) => publicKey({ id, ...record }));
}

function publicKey({ hash, ...record }) {
  return record;
}

function assertKnown(ids, entries, kind) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`At least one ${kind} is required`);
  for (const id of ids) requireEntry(entries, id, kind);
}

function requireEntry(entries, id, kind) {
  if (!entries[id]) throw new Error(`Unknown ${kind}: "${id}"`);
  return entries[id];
}

function requiredId(value) {
  if (typeof value !== "string" || !value) throw new Error("id is required");
  return value;
}
