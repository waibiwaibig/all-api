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
  if (!config || config.version !== 2) {
    throw new Error("All API config must use version 2; legacy configs are intentionally not migrated");
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
    || config.server.maxConcurrent < 1) {
    throw new Error("config.server requires host, port 0-65535, and positive maxConcurrent");
  }

  for (const [id, connector] of Object.entries(config.connectors)) {
    assertId("connector", id);
    if (!isRecord(connector)
      || !path.isAbsolute(connector.command ?? "")
      || !Array.isArray(connector.args ?? [])
      || !(connector.args ?? []).every((value) => typeof value === "string")
      || !isRecord(connector.capabilities)
      || !Array.isArray(connector.capabilities.input)
      || !Array.isArray(connector.capabilities.tools)) {
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
  }
  for (const [id, workspace] of Object.entries(config.workspaces)) {
    assertId("workspace", id);
    if (!isRecord(workspace) || !path.isAbsolute(workspace.path ?? "")) {
      throw new Error(`workspace "${id}" must use an absolute path`);
    }
  }
  for (const [id, key] of Object.entries(config.keys)) {
    assertId("key", id);
    if (!isRecord(key) || typeof key.hash !== "string") {
      throw new Error(`key "${id}" is invalid`);
    }
    if (!Array.isArray(key.models) || !Array.isArray(key.workspaces)) {
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
  }
  return config;
}

export async function createAccessKey({ name, models, workspaces }) {
  if (!name?.trim()) throw new Error("key name is required");
  const id = `key_${crypto.randomBytes(8).toString("hex")}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `allapi_${id}.${secret}`;
  const salt = crypto.randomBytes(16);
  const digest = await scrypt(token, salt, 32);
  return {
    token,
    record: {
      id,
      name: name.trim(),
      hash: `scrypt:${salt.toString("base64url")}:${Buffer.from(digest).toString("base64url")}`,
      models: [...new Set(models ?? [])],
      workspaces: [...new Set(workspaces ?? [])],
      createdAt: new Date().toISOString(),
    },
  };
}

export async function authorize(config, token) {
  if (typeof token !== "string" || !token.startsWith("allapi_")) {
    throw new HttpError(401, "Invalid API key", "invalid_api_key");
  }
  const separator = token.indexOf(".", "allapi_".length);
  if (separator < 0) throw new HttpError(401, "Invalid API key", "invalid_api_key");
  const id = token.slice("allapi_".length, separator);
  const record = config.keys[id];
  if (!record || !(await verifyKey(token, record.hash))) {
    throw new HttpError(401, "Invalid API key", "invalid_api_key");
  }
  return {
    keyId: id,
    name: record.name,
    models: [...record.models],
    workspaces: [...record.workspaces],
  };
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
