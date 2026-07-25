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
    version: 2,
    server: { host: "127.0.0.1", port: 8787, maxConcurrent: 4 },
    models: { codex: { agent: "codex", source: "local" } },
    workspaces: { demo: { path: workspace } },
    keys: {},
    connectors: {},
  };
}

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
        overrides: { approvalPolicy: "never", sandbox: "read-only" },
      },
    });
    const created = await adminRequest(endpoint, "key.create", {
      name: "phone",
      models: ["codex:review"],
      workspaces: ["demo"],
    });
    assert.match(created.token, /^allapi_/);

    const keys = await adminRequest(endpoint, "key.list");
    assert.equal(keys[0].name, "phone");
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
