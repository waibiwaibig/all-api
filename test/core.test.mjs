import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConfigStore,
  authorize,
  createAccessKey,
  validateConfig,
} from "../src/core.mjs";

function baseConfig() {
  return {
    version: 2,
    server: { host: "127.0.0.1", port: 8787, maxConcurrent: 4 },
    models: {
      codex: { agent: "codex", source: "local" },
      "claude:plan": {
        agent: "claude",
        source: "managed",
        overrides: { permissionMode: "plan" },
      },
    },
    workspaces: {
      demo: { path: "/tmp/demo" },
      secret: { path: "/tmp/secret" },
    },
    keys: {},
    connectors: {},
  };
}

test("access keys expose only their allowed models and workspaces", async () => {
  const config = baseConfig();
  const { token, record } = await createAccessKey({
    name: "phone",
    models: ["codex"],
    workspaces: ["demo"],
  });
  config.keys[record.id] = record;

  const grant = await authorize(config, token);
  assert.deepEqual(grant.models, ["codex"]);
  assert.deepEqual(grant.workspaces, ["demo"]);
  assert.equal(grant.keyId, record.id);
  await assert.rejects(() => authorize(config, `${token}x`), /invalid API key/i);
});

test("config validation rejects legacy and dangling grants", () => {
  assert.throws(() => validateConfig({ models: {} }), /version 2/i);

  const config = baseConfig();
  config.keys.bad = {
    name: "bad",
    hash: "scrypt:not-a-real-hash",
    models: ["missing"],
    workspaces: ["demo"],
  };
  assert.throws(() => validateConfig(config), /unknown model "missing"/i);
});

test("ConfigStore writes version 2 atomically and never migrates legacy config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-config-"));
  const filename = path.join(directory, "config.json");
  const store = new ConfigStore(filename);
  await store.save(baseConfig());
  assert.equal((await store.load()).version, 2);

  await rm(directory, { recursive: true, force: true });
});
