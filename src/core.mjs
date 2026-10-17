import crypto from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export class HttpError extends Error {
  constructor(status, message, code = "invalid_request_error", parameter) {
    super(message);
    this.status = status;
    this.code = code;
    this.parameter = parameter;
  }
}

export class ConfigStore {
  constructor(filename) {
    this.filename = filename;
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`All API is not initialized: ${this.filename}`);
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${this.filename}: ${error.message}`);
      throw error;
    }
    return validateConfig(parsed);
  }

  async save(config) {
    validateConfig(config);
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.filename);
  }
}

export function validateConfig(config) {
  if (!config || config.version !== 4) {
    throw new Error("All API config must use version 4; legacy configs are intentionally not migrated");
  }
  for (const field of ["models", "workspaces", "keys", "connectors"]) {
    if (!isRecord(config[field])) throw new Error(`config.${field} must be an object`);
  }
  if (!isRecord(config.server)) throw new Error("config.server must be an object");
  if (typeof config.server.host !== "string"
    || !Number.isInteger(config.server.port)
    || config.server.port < 0
    || config.server.port > 65535
    || !Number.isInteger(config.server.maxConcurrent)
    || config.server.maxConcurrent < 1
    || !Number.isInteger(config.server.maxNativeConnections)
    || config.server.maxNativeConnections < 1
    || !Number.isInteger(config.server.maxNativeFrameBytes)
    || config.server.maxNativeFrameBytes < 1
    || !Number.isInteger(config.server.maxNativeBufferedBytes)
    || config.server.maxNativeBufferedBytes < 1
    || !Number.isInteger(config.server.responseRetentionDays)
    || config.server.responseRetentionDays < 1
    || (config.server.responsesIncludeProcessEvents !== undefined
      && typeof config.server.responsesIncludeProcessEvents !== "boolean")) {
    throw new Error(
      "config.server requires host, port 0-65535, positive concurrency and Native limits, "
      + "and an optional boolean responsesIncludeProcessEvents",
    );
  }

  for (const [id, connector] of Object.entries(config.connectors)) {
    assertId("connector", id);
    if (!isRecord(connector)
      || !path.isAbsolute(connector.command ?? "")
      || !Array.isArray(connector.args ?? [])
      || !(connector.args ?? []).every((value) => typeof value === "string")
      || !isRecord(connector.capabilities)
      || !Array.isArray(connector.capabilities.input)
      || !Array.isArray(connector.capabilities.tools)
      || !connector.capabilities.input.every((value) => typeof value === "string")
      || !connector.capabilities.tools.every((value) => typeof value === "string")
      || typeof connector.capabilities.native !== "boolean"
      || (connector.env !== undefined && (
        !isRecord(connector.env)
        || !Object.values(connector.env).every((value) => typeof value === "string")
      ))
      || (connector.version !== undefined && typeof connector.version !== "string")
      || (connector.native !== undefined && (
        !isRecord(connector.native)
        || typeof connector.native.transport !== "string"
        || typeof connector.native.protocol !== "string"
        || (connector.native.protocolVersion !== null
          && typeof connector.native.protocolVersion !== "string")
        || typeof connector.native.resumable !== "boolean"
        || typeof connector.native.clientTools !== "boolean"
      ))) {
      throw new Error(`connector "${id}" must declare an absolute command, string args, and capabilities`);
    }
  }

  for (const [id, model] of Object.entries(config.models)) {
    assertId("model", id);
    if (!isRecord(model) || typeof model.agent !== "string") {
      throw new Error(`model "${id}" must declare an agent`);
    }
    if (!["codex", "claude"].includes(model.agent) && !config.connectors[model.agent]) {
      throw new Error(`model "${id}" uses unknown agent "${model.agent}"`);
    }
    if (!["local", "managed"].includes(model.source)) {
      throw new Error(`model "${id}" source must be local or managed`);
    }
    if (model.source === "managed" && !isRecord(model.overrides)) {
      throw new Error(`managed model "${id}" must declare overrides`);
    }
    if (model.source === "managed") validateManagedOverrides(id, model);
    if (typeof model.workspace !== "string" || !config.workspaces[model.workspace]) {
      throw new Error(`model "${id}" uses unknown workspace "${model.workspace}"`);
    }
  }
  for (const [id, workspace] of Object.entries(config.workspaces)) {
    assertId("workspace", id);
    if (!isRecord(workspace) || !path.isAbsolute(workspace.path ?? "")) {
      throw new Error(`workspace "${id}" must use an absolute path`);
    }
  }
  for (const [id, key] of Object.entries(config.keys)) {
    assertId("key", id);
    if (!isRecord(key)
      || typeof key.name !== "string"
      || typeof key.hash !== "string"
      || !["access", "native"].includes(key.kind)) {
      throw new Error(`key "${id}" is invalid`);
    }
    if (key.kind === "native") {
      if (key.models !== undefined || key.workspaces !== undefined || key.defaultWorkspace !== undefined) {
        throw new Error(`native key "${id}" must not declare grants`);
      }
      continue;
    }
    if (!Array.isArray(key.models)
      || key.models.length === 0
      || !Array.isArray(key.workspaces)
      || key.workspaces.length === 0) {
      throw new Error(`key "${id}" grants must be arrays`);
    }
    for (const model of key.models ?? []) {
      if (!config.models[model]) throw new Error(`key "${id}" grants unknown model "${model}"`);
    }
    for (const workspace of key.workspaces ?? []) {
      if (!config.workspaces[workspace]) {
        throw new Error(`key "${id}" grants unknown workspace "${workspace}"`);
      }
    }
    if (!key.workspaces.includes(key.defaultWorkspace)) {
      throw new Error(`key "${id}" defaultWorkspace must be one of its workspace grants`);
    }
  }
  if (config.executables !== undefined && (!isRecord(config.executables) || Object.entries(config.executables).some(([name, executable]) => !['codex', 'claude'].includes(name) || !path.isAbsolute(executable)))) throw new Error('Agent executables must be absolute codex/claude paths');
  if (config.secretary !== undefined) {
    const s = config.secretary;
    if (!isRecord(s) || !/^[\w-]{36}$/.test(s.id ?? '') || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60
      || !config.models[s.model] || !config.workspaces[s.workspace] || typeof s.keyId !== 'string') throw new Error('Invalid secretary configuration');
    const u = new URL(s.url);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)))) throw new Error('Secretary URL requires HTTPS or loopback HTTP');
  }
  return config;
}

function validateManagedOverrides(id, model) {
  if (!["codex", "claude"].includes(model.agent)) return;
  const allowed = model.agent === "codex"
    ? ["thread", "turn", "native"]
    : ["options", "native"];
  for (const field of Object.keys(model.overrides)) {
    if (!allowed.includes(field)) {
      throw new Error(`managed model "${id}" has unknown ${model.agent} override block "${field}"`);
    }
  }
  for (const field of allowed.filter((field) => field !== "native")) {
    if (model.overrides[field] !== undefined && !isRecord(model.overrides[field])) {
      throw new Error(`managed model "${id}" overrides.${field} must be an object`);
    }
  }
  const native = model.overrides.native;
  if (native === undefined) return;
  if (!isRecord(native)
    || (native.args !== undefined && (
      !Array.isArray(native.args)
      || !native.args.every((value) => typeof value === "string")
    ))
    || (native.env !== undefined && (
      !isRecord(native.env)
      || !Object.values(native.env).every((value) => typeof value === "string")
    ))) {
    throw new Error(`managed model "${id}" overrides.native requires string args and env`);
  }
  for (const field of Object.keys(native)) {
    if (!["args", "env"].includes(field)) {
      throw new Error(`managed model "${id}" has unknown native override "${field}"`);
    }
  }
}

export async function createApiKey({
  kind,
  name,
  models,
  workspaces,
  defaultWorkspace,
}) {
  if (!["access", "native"].includes(kind)) throw new Error("key kind must be access or native");
  if (!name?.trim()) throw new Error("key name is required");
  if (kind === "native"
    && (models !== undefined || workspaces !== undefined || defaultWorkspace !== undefined)) {
    throw new Error("native keys must not declare grants");
  }
  if (kind === "access" && (
    !Array.isArray(models)
    || models.length === 0
    || !Array.isArray(workspaces)
    || workspaces.length === 0
    || !workspaces.includes(defaultWorkspace)
  )) {
    throw new Error("access keys require models, workspaces, and a granted defaultWorkspace");
  }
  const id = `key_${crypto.randomBytes(8).toString("hex")}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `allapi_${kind}_${id}.${secret}`;
  const salt = crypto.randomBytes(16);
  const digest = await scrypt(token, salt, 32);
  const grants = kind === "access"
    ? {
        models: [...new Set(models ?? [])],
        workspaces: [...new Set(workspaces ?? [])],
        defaultWorkspace,
      }
    : {};
  return {
    token,
    record: {
      id,
      kind,
      name: name.trim(),
      hash: `scrypt:${salt.toString("base64url")}:${Buffer.from(digest).toString("base64url")}`,
      ...grants,
      createdAt: new Date().toISOString(),
    },
  };
}

export async function authorize(config, token, expectedKind) {
  const match = typeof token === "string"
    ? /^allapi_(access|native)_(key_[a-f0-9]{16})\./.exec(token)
    : null;
  if (!match) {
    throw new HttpError(401, "Invalid API key", "invalid_api_key");
  }
  const [, kind, id] = match;
  const record = config.keys[id];
  if (!record || record.kind !== kind || !(await verifyKey(token, record.hash))) {
    throw new HttpError(401, "Invalid API key", "invalid_api_key");
  }
  if (config.keys[id] !== record) {
    throw new HttpError(401, "Invalid API key", "invalid_api_key");
  }
  if (expectedKind && kind !== expectedKind) {
    throw new HttpError(403, `This endpoint requires an ${expectedKind} API key`, "permission_denied");
  }
  const identity = {
    keyId: id,
    kind,
    name: record.name,
  };
  return kind === "access"
    ? {
        ...identity,
        models: [...record.models],
        workspaces: [...record.workspaces],
        defaultWorkspace: record.defaultWorkspace,
      }
    : identity;
}

export function requireGrant(grant, kind, id) {
  if (!grant[`${kind}s`]?.includes(id)) {
    throw new HttpError(403, `${kind} "${id}" is not allowed by this API key`, "permission_denied");
  }
}

export function strictObject(value, allowed, required = []) {
  if (!isRecord(value)) throw new HttpError(400, "request body must be a JSON object");
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new HttpError(400, `Unknown parameter: '${field}'`, "invalid_request_error", field);
    }
  }
  for (const field of required) {
    if (value[field] === undefined) {
      throw new HttpError(400, `Missing required parameter: '${field}'`, "invalid_request_error", field);
    }
  }
  return value;
}

export class ConcurrencyGate {
  #active = 0;

  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
  }

  acquire() {
    if (this.#active >= this.limit) {
      throw new HttpError(429, "All API is busy; retry later", "server_busy");
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#active -= 1;
      }
    };
  }

  get active() {
    return this.#active;
  }
}

async function verifyKey(token, encoded) {
  const [algorithm, saltValue, digestValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !digestValue) return false;
  const actual = Buffer.from(await scrypt(token, Buffer.from(saltValue, "base64url"), 32));
  const expected = Buffer.from(digestValue, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function assertId(kind, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`${kind} id "${id}" is invalid`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
