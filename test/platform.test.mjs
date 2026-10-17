import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  restoreExposure,
  startManagedProcess,
  stopExposure,
} from "../src/platform.mjs";

test("managed exposure only records a live process and refuses to orphan another", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-exposure-"));
  const statePath = path.join(directory, "exposure.json");
  let pid;
  try {
    await assert.rejects(
      startManagedProcess(process.execPath, ["-e", "process.exit(7)"], {
        statePath,
        provider: "fixture",
        startupTimeoutMs: 300,
      }),
      /exited during startup/,
    );
    await assert.rejects(access(statePath), { code: "ENOENT" });

    const started = await startManagedProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        statePath,
        provider: "fixture",
        startupTimeoutMs: 300,
      },
    );
    pid = started.pid;
    const restored = await restoreExposure({ dataDirectory: directory, localPort: 8787 });
    assert.equal(restored.alreadyRunning, true);
    await assert.rejects(
      startManagedProcess(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          statePath,
          provider: "fixture",
          startupTimeoutMs: 300,
        },
      ),
      /already running/,
    );

    const stopped = await stopExposure("fixture", { dataDirectory: directory });
    assert.equal(stopped.processFound, true);
    pid = undefined;
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('autostart launcher preserves isolated home and execution PATH without copying unrelated secrets', async () => {
  const { autostartLauncher } = await import('../src/platform.mjs');
  const source = autostartLauncher('/tmp/my secretary', '/tmp/all api/src/cli.mjs', { PATH: '/tools:/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7897', PRIVATE_TOKEN: 'never-copy' });
  assert.ok(source.includes('"ALL_API_HOME":"/tmp/my secretary"'));
  assert.ok(source.includes('"PATH":"/tools:/usr/bin"'));
  assert.ok(source.includes('all%20api/src/cli.mjs'));
  assert.ok(!source.includes('never-copy'));
});
