import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ClaudeAdapter,
  CodexAdapter,
  ConnectorAdapter,
} from "../src/agents.mjs";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const profile = { agent: "fixture", source: "local" };
const workspace = { id: "demo", path: process.cwd() };

test("Codex adapter speaks app-server JSON-RPC and preserves the thread id", async () => {
  const shim = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex],
  });
  const events = [];
  for await (const event of shim.run({
    model: "codex",
    profile,
    workspace,
    input: [{ type: "text", text: "hello" }],
    tools: [],
    signal: new AbortController().signal,
  })) events.push(event);

  assert.equal(events.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "official codex");
  assert.equal(events.at(-1).sessionId, "codex-thread-1");
  assert.deepEqual(events.at(-1).usage, { input_tokens: 8, output_tokens: 2 });
});

test("Codex native transport passes app-server JSON-RPC frames without an All API envelope", async () => {
  const adapter = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex],
  });
  const outputs = [];
  const native = await adapter.openNative({
    send: (frame) => outputs.push(frame),
    fail: (error) => { throw error; },
    workspace,
  });
  const input = '{"id":"raw-1","method":"initialize","params":{}}';
  await native.receive(Buffer.from(input), false);
  const reply = await waitFor(() => outputs[0]);
  assert.equal(reply, '{"id":"raw-1","result":{"userAgent":"fake-codex"}}');
  await native.close();
});

test("Claude adapter consumes official SDK messages and resumes the SDK session", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    executable: "/usr/local/bin/claude",
    query(options) {
      calls.push(options);
      return (async function* () {
        yield {
          type: "assistant",
          session_id: "claude-session-1",
          message: { content: [{ type: "text", text: "official claude" }] },
        };
        yield {
          type: "result",
          session_id: "claude-session-1",
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      })();
    },
  });
  const events = [];
  for await (const event of adapter.run({
    model: "claude",
    profile,
    workspace,
    input: [{ type: "text", text: "hello" }],
    tools: [],
    sessionId: "resume-me",
    signal: new AbortController().signal,
  })) events.push(event);

  assert.equal(calls[0].options.resume, "resume-me");
  assert.deepEqual(calls[0].options.settingSources, ["user", "project", "local"]);
  assert.equal(calls[0].options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.equal(events[0].delta, "official claude");
  assert.equal(events[1].sessionId, "claude-session-1");
});

test("Claude native transport forwards official stream-json frames without interpreting controls", async () => {
  const outputs = [];
  const adapter = new ClaudeAdapter({
    executable: process.execPath,
    nativeArgs: [fakeCodex],
  });
  const native = await adapter.openNative({
    send: (message) => outputs.push(message),
    fail: (error) => { throw error; },
    workspace,
    profile,
  });
  const input = '{"type":"control_response","response":{"subtype":"success","request_id":"permission-1"}}';
  await native.receive(Buffer.from(input), false);
  assert.equal(await waitFor(() => outputs[0]), input);
  await native.close();
});

test("connector adapter uses the stable initialize/session event contract", () => {
  const adapter = new ConnectorAdapter({
    command: process.execPath,
    args: ["connector.mjs"],
    capabilities: { input: ["text"], tools: [], native: true },
  });
  assert.equal(adapter.capabilities.native, true);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for native event");
}
