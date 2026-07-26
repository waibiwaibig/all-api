import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ClaudeAdapter,
  CodexAdapter,
  ConnectorAdapter,
  JsonLinePeer,
} from "../src/agents.mjs";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const profile = { agent: "fixture", source: "local" };
const workspace = { id: "demo", path: process.cwd() };

test("JSON-RPC requests time out when an Agent stays silent", async () => {
  const peer = new JsonLinePeer(process.execPath, [fakeCodex, "--ignore-all"], {
    rpcTimeoutMs: 25,
  });
  await assert.rejects(peer.request("initialize"), /timed out.*initialize/i);
  await peer.close();
});

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

test("Codex adapter rejects promptly when app-server exits mid-turn", async () => {
  const adapter = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex, "--exit-after-turn"],
  });
  const run = async () => {
    for await (const event of adapter.run({
      model: "codex",
      profile,
      workspace,
      input: [{ type: "text", text: "hello" }],
      tools: [],
      signal: new AbortController().signal,
    })) void event;
  };
  await assert.rejects(
    Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 500)),
    ]),
    /Agent transport exited/,
  );
});

test("managed Codex profiles pass official thread and turn params without a whitelist", async () => {
  const adapter = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex, "--echo-params"],
  });
  let output = "";
  for await (const event of adapter.run({
    model: "codex",
    profile: {
      agent: "codex",
      source: "managed",
      overrides: {
        thread: { futureThreadField: { enabled: true } },
        turn: { futureTurnField: "native-value" },
      },
    },
    workspace,
    input: [{ type: "text", text: "hello" }],
    tools: [],
    signal: new AbortController().signal,
  })) {
    if (event.type === "text.delta") output += event.delta;
  }
  assert.match(output, /"futureThreadField":\{"enabled":true\}/);
  assert.match(output, /"futureTurnField":"native-value"/);
});

test("Codex adapter surfaces an approval request as information and interrupts the turn", async () => {
  const adapter = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex, "--request-approval"],
  });
  const events = [];
  for await (const event of adapter.run({
    model: "codex",
    profile,
    workspace,
    input: "hello",
    tools: [],
    signal: new AbortController().signal,
  })) events.push(event);
  const interaction = events.find((event) => event.type === "interaction");
  assert.equal(interaction.payload.method, "item/commandExecution/requestApproval");
  assert.equal(interaction.payload.params.command, "touch approval.txt");
  assert.equal(events.at(-1).type, "interrupted");
});

test("Codex adapter preserves process notifications for standard text conversion", async () => {
  const adapter = new CodexAdapter({
    executable: process.execPath,
    appServerArgs: [fakeCodex, "--emit-process-event"],
  });
  const events = [];
  for await (const event of adapter.run({
    model: "codex",
    profile,
    workspace,
    input: "hello",
    tools: [],
    signal: new AbortController().signal,
  })) events.push(event);
  const processEvent = events.find((event) => event.type === "agent.event");
  assert.equal(processEvent.payload.method, "item/commandExecution/outputDelta");
  assert.equal(processEvent.payload.params.delta, "command output");
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
          subtype: "success",
          is_error: false,
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

test("managed Claude profiles pass official SDK options without a whitelist", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    query(options) {
      calls.push(options);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session-1",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })();
    },
  });
  for await (const event of adapter.run({
    model: "claude",
    profile: {
      agent: "claude",
      source: "managed",
      overrides: {
        options: { futureOfficialOption: { enabled: true } },
      },
    },
    workspace,
    input: "hello",
    tools: [],
    signal: new AbortController().signal,
  })) void event;
  assert.deepEqual(calls[0].options.futureOfficialOption, { enabled: true });
});

test("Claude certification is invalidated when the executable version changes", async () => {
  let version = "2.1.119";
  const adapter = new ClaudeAdapter();
  adapter.describe = async () => ({ version });
  assert.equal((await adapter.verifyStandard()).status, "verified");
  version = "2.1.120";
  assert.equal((await adapter.verifyStandard()).status, "unverified");
});

test("Claude adapter rejects official SDK error results", async () => {
  const adapter = new ClaudeAdapter({
    query() {
      return (async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Maximum turns reached"],
          session_id: "claude-session-1",
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      })();
    },
  });
  const run = async () => {
    for await (const event of adapter.run({
      model: "claude",
      profile,
      workspace,
      input: "hello",
      tools: [],
      signal: new AbortController().signal,
    })) void event;
  };
  await assert.rejects(run(), /Maximum turns reached/);
});

test("Claude adapter surfaces permission callbacks as information", async () => {
  const adapter = new ClaudeAdapter({
    query({ options }) {
      return (async function* () {
        await options.canUseTool("Bash", { command: "touch approval.txt" }, {
          toolUseID: "tool-1",
          requestId: "request-1",
          title: "Claude wants to run a command",
          signal: new AbortController().signal,
        });
        yield {
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            usage: { input_tokens: 4, output_tokens: 1 },
            content: [],
          },
        };
      })();
    },
  });
  const events = [];
  for await (const event of adapter.run({
    model: "claude",
    profile,
    workspace,
    input: "hello",
    tools: [],
    signal: new AbortController().signal,
  })) events.push(event);
  assert.equal(events[0].type, "interaction");
  assert.equal(events[0].payload.toolName, "Bash");
  assert.deepEqual(events[0].payload.input, { command: "touch approval.txt" });
  assert.equal(events.at(-1).type, "interrupted");
  assert.deepEqual(events.at(-1).usage, { input_tokens: 4, output_tokens: 1 });
});

test("Claude adapter preserves non-answer process messages", async () => {
  const adapter = new ClaudeAdapter({
    query() {
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
          cwd: workspace.path,
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session-1",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })();
    },
  });
  const events = [];
  for await (const event of adapter.run({
    model: "claude",
    profile,
    workspace,
    input: "hello",
    tools: [],
    signal: new AbortController().signal,
  })) events.push(event);
  assert.equal(events[0].type, "agent.event");
  assert.equal(events[0].payload.subtype, "init");
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
