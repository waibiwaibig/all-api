import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireLocalAgentSlot,
  chatCompletion,
  extractClaudeText,
  extractCodexText,
  messagesToPrompt,
  run,
} from "../src/cli.mjs";

test("messagesToPrompt keeps roles and text content", () => {
  assert.equal(
    messagesToPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]),
    "SYSTEM:\nBe terse.\n\nUSER:\nHello",
  );
});

test("extractClaudeText reads json result", () => {
  assert.equal(extractClaudeText(JSON.stringify({ result: "done" })), "done");
});

test("extractCodexText reads last json text event", () => {
  const stdout = [
    JSON.stringify({ type: "start" }),
    JSON.stringify({ item: { content: [{ type: "text", text: "final answer" }] } }),
  ].join("\n");
  assert.equal(extractCodexText(stdout), "final answer");
});

test("chatCompletion returns OpenAI-compatible shape", () => {
  const response = chatCompletion("codex-local", "hello");
  assert.equal(response.object, "chat.completion");
  assert.equal(response.model, "codex-local");
  assert.equal(response.choices[0].message.role, "assistant");
  assert.equal(response.choices[0].message.content, "hello");
});

test("run aborts an owned child process", async () => {
  const controller = new AbortController();
  const resultPromise = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    timeoutMs: 5000,
  });

  setTimeout(() => controller.abort(), 50).unref();
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
});

test("run cleans up descendants from its owned process group", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(child.pid);
    setTimeout(() => process.exit(0), 20);
  `;

  const result = await run(process.execPath, ["-e", script], { timeoutMs: 1000 });
  const descendantPid = Number(result.stdout.trim());

  assert.equal(result.ok, true);
  assert.equal(Number.isInteger(descendantPid), true);
  await waitForProcessExit(descendantPid);
});

test("local agent slot rejects overlapping runs for the same model", () => {
  const model = { id: `test-model-${Date.now()}`, type: "codex", maxConcurrent: 1 };
  const release = acquireLocalAgentSlot(model);

  try {
    assert.throws(
      () => acquireLocalAgentSlot(model),
      /do not pile up agent processes/,
    );
  } finally {
    release();
  }

  const releaseAgain = acquireLocalAgentSlot(model);
  releaseAgain();
});

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} was still running`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
