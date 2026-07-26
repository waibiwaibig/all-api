import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConfigStore,
  authorize,
  createApiKey,
  validateConfig,
} from "../src/core.mjs";

function baseConfig() {
  return {
    version: 3,
    server: {
      host: "127.0.0.1",
      port: 8787,
      maxConcurrent: 4,
      maxNativeConnections: 8,
      maxNativeFrameBytes: 1_048_576,
      maxNativeBufferedBytes: 4_194_304,
    },
    models: {
      codex: { agent: "codex", source: "local", workspace: "demo" },
      "claude:plan": {
        agent: "claude",
        source: "managed",
        workspace: "demo",
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
  const { token, record } = await createApiKey({
    kind: "access",
    name: "phone",
    models: ["codex"],
    workspaces: ["demo"],
    defaultWorkspace: "demo",
  });
  config.keys[record.id] = record;

  const grant = await authorize(config, token);
  assert.equal(grant.kind, "access");
  assert.deepEqual(grant.models, ["codex"]);
  assert.deepEqual(grant.workspaces, ["demo"]);
  assert.equal(grant.defaultWorkspace, "demo");
  assert.equal(grant.keyId, record.id);
  await assert.rejects(() => authorize(config, `${token}x`), /invalid API key/i);
});

test("native keys are separate credentials without model or workspace grants", async () => {
  const config = baseConfig();
  const { token, record } = await createApiKey({ kind: "native", name: "desktop" });
  config.keys[record.id] = record;

  const grant = await authorize(config, token, "native");
  assert.deepEqual(grant, { keyId: record.id, kind: "native", name: "desktop" });
  await assert.rejects(() => authorize(config, token, "access"), /requires an access API key/i);
  await assert.rejects(
    () => createApiKey({ kind: "native", name: "bad", models: ["codex"] }),
    /must not declare grants/i,
  );
});

test("config validation rejects legacy, dangling grants, and scoped native keys", () => {
  assert.throws(() => validateConfig({ models: {} }), /version 3/i);

  const config = baseConfig();
  config.keys.bad = {
    kind: "access",
    name: "bad",
    hash: "scrypt:not-a-real-hash",
    models: ["missing"],
    workspaces: ["demo"],
    defaultWorkspace: "demo",
  };
  assert.throws(() => validateConfig(config), /unknown model "missing"/i);

  const nativeConfig = baseConfig();
  nativeConfig.keys.bad = {
    kind: "native",
    name: "bad",
    hash: "scrypt:not-a-real-hash",
    models: ["codex"],
  };
  assert.throws(() => validateConfig(nativeConfig), /must not declare grants/i);
});

test("ConfigStore writes version 3 atomically and never migrates legacy config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-config-"));
  const filename = path.join(directory, "config.json");
  const store = new ConfigStore(filename);
  await store.save(baseConfig());
  assert.equal((await store.load()).version, 3);

  await rm(directory, { recursive: true, force: true });
});
