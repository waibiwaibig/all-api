import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("CLI initializes, starts, reports health, and stops through local management", async () => {
  const directory = path.join(tmpdir(), `all-api-cli-${process.pid}-${Date.now()}`);
  const port = await freePort();
  const env = { ...process.env, ALL_API_HOME: directory };
  let pid;
  try {
    const initialized = await run(["init", "--workspace", process.cwd(), "--port", String(port)], env);
    assert.equal(initialized.models.includes("codex"), true);
    const configText = await readFile(path.join(directory, "config.json"), "utf8");
    assert.doesNotMatch(configText, /allapi_key_/);
    assert.equal(JSON.parse(configText).version, 2);

    const started = await run(["up"], env);
    pid = started.pid;
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).status, "ok");

    const status = await run(["status"], env);
    assert.equal(status.server.running, true);
    await run(["down"], env);
    await waitUntilStopped(port);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function run(args, env) {
  const { stdout } = await execute(process.execPath, [cli, ...args], {
    env,
    timeout: 20_000,
  });
  return JSON.parse(stdout);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntilStopped(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("All API server did not stop");
}
