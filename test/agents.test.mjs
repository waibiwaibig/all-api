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

test("Claude native transport keeps streaming input and bridges official permission callbacks", async () => {
  const outputs = [];
  let permissionResult;
  const adapter = new ClaudeAdapter({
    executable: "/usr/local/bin/claude",
    query({ prompt, options }) {
      const stream = (async function* () {
        for await (const message of prompt) {
          yield { type: "user_echo", message };
          permissionResult = await options.canUseTool("Bash", { command: "pwd" }, {
            signal: new AbortController().signal,
            requestId: "permission-1",
            toolUseID: "tool-1",
            suggestions: [],
          });
          yield { type: "result", session_id: "claude-native-1", permissionResult };
        }
      })();
      stream.interrupt = async () => {};
      stream.setPermissionMode = async () => {};
      stream.setModel = async () => {};
      return stream;
    },
  });
  const native = await adapter.openNative({ send: (message) => outputs.push(message), workspace, profile });
  await native.receive("hello");
  await waitFor(() => outputs.find((message) => message.type === "permission_request"));
  assert.equal(outputs.find((message) => message.type === "permission_request").request_id, "permission-1");
  await native.receive({
    type: "permission_response",
    request_id: "permission-1",
    result: { behavior: "allow", updatedInput: { command: "pwd" } },
  });
  await waitFor(() => outputs.find((message) => message.type === "result"));
  assert.equal(permissionResult.behavior, "allow");
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
