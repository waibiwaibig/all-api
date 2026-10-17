import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adminEndpoint,
  adminRequest,
  createAdminServer,
} from "../src/admin.mjs";
import { ConfigStore } from "../src/core.mjs";

function config(workspace) {
  return {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: 8787,
      maxConcurrent: 4,
      maxNativeConnections: 8,
      maxNativeFrameBytes: 1_048_576,
      maxNativeBufferedBytes: 4_194_304,
      responseRetentionDays: 30,
    },
    models: { codex: { agent: "codex", source: "local", workspace: "demo" } },
    workspaces: { demo: { path: workspace } },
    keys: {},
    connectors: {},
  };
}

test("agent export defaults to this deployment and scopes each application credential", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-local-secretary-"));
  let current = config(directory);
  current.server.port = 9189;
  const endpoint = adminEndpoint(directory);
  const server = await createAdminServer({
    endpoint,
    getConfig: () => current,
    async saveConfig(next) { current = next; },
  });
  try {
    const connection = await adminRequest(endpoint, "agent.export", {
      model: "codex", workspace: "demo",
    });
    assert.equal(connection.agentCardUrl, "http://127.0.0.1:9189/.well-known/agent-card.json");
    assert.deepEqual(Object.values(current.keys).at(-1).models, ["codex"]);
    assert.deepEqual(Object.values(current.keys).at(-1).workspaces, ["demo"]);
    const second = await adminRequest(endpoint, "agent.export", { model: "codex", workspace: "demo" });
    assert.notEqual(second.token, connection.token);
    assert.equal(current.secretary, undefined);
    assert.equal(connection.agent, "codex");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("management RPC is local-only and mutates profiles, workspaces, and keys separately", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-admin-"));
  const store = new ConfigStore(path.join(directory, "config.json"));
  let current = config(directory);
  await store.save(current);
  const endpoint = adminEndpoint(directory);
  const server = await createAdminServer({
    endpoint,
    getConfig: () => current,
    async saveConfig(next) {
      await store.save(next);
      current = next;
    },
  });

  try {
    if (process.platform !== "win32") {
      assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
    }
    await adminRequest(endpoint, "profile.put", {
      id: "codex:review",
      profile: {
        agent: "codex",
        source: "managed",
        workspace: "demo",
        overrides: {
          thread: { approvalPolicy: "never", sandbox: "read-only" },
        },
      },
    });
    const created = await adminRequest(endpoint, "key.create", {
      kind: "access",
      name: "phone",
      models: ["codex:review"],
      workspaces: ["demo"],
      defaultWorkspace: "demo",
    });
    assert.match(created.token, /^allapi_/);

    const keys = await adminRequest(endpoint, "key.list");
    assert.equal(keys[0].name, "phone");
    assert.equal(keys[0].kind, "access");
    assert.equal("hash" in keys[0], false);
    assert.deepEqual(keys[0].models, ["codex:review"]);

    await assert.rejects(
      () => adminRequest(endpoint, "profile.delete", { id: "codex:review" }),
      /still granted/i,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("management creates unscoped native keys and reports revocation to the running server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-admin-"));
  let current = config(directory);
  const revoked = [];
  const endpoint = adminEndpoint(directory);
  const server = await createAdminServer({
    endpoint,
    getConfig: () => current,
    async saveConfig(next) { current = next; },
    async onKeyRevoked(id) { revoked.push(id); },
  });
  try {
    const created = await adminRequest(endpoint, "key.create", {
      kind: "native",
      name: "native desktop",
    });
    assert.match(created.token, /^allapi_native_/);
    assert.equal(created.kind, "native");
    assert.equal("models" in created, false);
    await adminRequest(endpoint, "key.revoke", { id: created.id });
    assert.deepEqual(revoked, [created.id]);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
