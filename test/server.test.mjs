import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createApiKey } from "../src/core.mjs";
import { AgentRegistry } from "../src/agents.mjs";
import { createAllApiServer, ResponseStore } from "../src/server.mjs";

async function fixture({
  maxConcurrent = 4,
  maxNativeConnections = 8,
  maxNativeFrameBytes = 1_048_576,
  maxNativeBufferedBytes = 4_194_304,
  standardStatus = "verified",
  nativeOpenDelay = 0,
  standardProtocols,
  standardCompletionDelay = 0,
  nativeSendsReady = true,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-server-"));
  const { token, record } = await createApiKey({
    kind: "access",
    name: "test",
    models: ["fixture"],
    workspaces: ["demo"],
    defaultWorkspace: "demo",
  });
  const { token: otherToken, record: otherRecord } = await createApiKey({
    kind: "access",
    name: "other",
    models: ["fixture"],
    workspaces: ["demo"],
    defaultWorkspace: "demo",
  });
  const { token: nativeToken, record: nativeRecord } = await createApiKey({
    kind: "native",
    name: "native",
  });
  const runs = [];
  const nativeInputs = [];
  const nativeCloses = [];
  const adapter = {
    capabilities: {
      input: ["text", "image", "file"],
      tools: ["agent"],
      approvals: true,
      continuation: true,
      native: true,
      usage: true,
    },
    async describe() {
      return { version: "fixture-1.0" };
    },
    async verifyStandard() {
      return {
        status: standardStatus,
        reason: standardStatus === "verified" ? null : "fixture",
        protocols: standardProtocols ?? {
          chat_completions: { status: standardStatus },
          responses: { status: standardStatus },
          messages: { status: standardStatus },
        },
      };
    },
    async *run(request) {
      runs.push(request);
      yield { type: "text.delta", delta: "hel" };
      yield { type: "text.delta", delta: "lo" };
      if (standardCompletionDelay) {
        await new Promise((resolve) => setTimeout(resolve, standardCompletionDelay));
      }
      yield {
        type: "completed",
        sessionId: request.sessionId ?? "agent-session-1",
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    },
    async openNative({ send }) {
      if (nativeOpenDelay) {
        await new Promise((resolve) => setTimeout(resolve, nativeOpenDelay));
      }
      if (nativeSendsReady) send('{"type":"agent.ready","session_id":"native-1"}');
      return {
        async receive(message, isBinary) {
          nativeInputs.push({ message: Buffer.from(message), isBinary });
          send(message, isBinary);
        },
        async close() {
          nativeCloses.push(true);
        },
      };
    },
  };
  const registry = new AgentRegistry();
  registry.register("fixture", adapter);
  const config = {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: 0,
      maxConcurrent,
      maxNativeConnections,
      maxNativeFrameBytes,
      maxNativeBufferedBytes,
      responseRetentionDays: 30,
    },
    models: { fixture: { agent: "fixture", source: "local", workspace: "demo" } },
    workspaces: {
      demo: { path: directory },
      hidden: { path: "/tmp/hidden" },
    },
    keys: {
      [record.id]: record,
      [otherRecord.id]: otherRecord,
      [nativeRecord.id]: nativeRecord,
    },
    connectors: {
      fixture: {
        command: process.execPath,
        args: [],
        capabilities: adapter.capabilities,
      },
    },
  };
  const app = await createAllApiServer({
    config,
    registry,
    dataDirectory: directory,
  });
  await app.listen();
  const address = app.server.address();
  return {
    ...app,
    token,
    otherToken,
    nativeToken,
    nativeKeyId: nativeRecord.id,
    runs,
    nativeInputs,
    nativeCloses,
    directory,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async cleanup() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function request(app, pathname, body, headers = {}) {
  return fetch(`${app.baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${app.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Response records expire after the configured retention period", () => {
  let now = 1_700_000_000_000;
  const store = new ResponseStore(undefined, {
    retentionDays: 30,
    now: () => now,
  });
  store.create({
    id: "resp_expiring",
    keyId: "key_1",
    model: "fixture",
    workspace: "demo",
    persist: true,
  });
  now += 30 * 86_400_000 + 1;
  assert.throws(() => store.require("resp_expiring", "key_1"), /not found/i);
});

test("Response retention removes expired records without requiring a lookup or restart", async () => {
  const store = new ResponseStore(undefined, { retentionDays: 0.000001 });
  store.create({
    id: "resp_background_expiry",
    keyId: "key_1",
    model: "fixture",
    workspace: "demo",
    persist: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(store.snapshot(), []);
  await store.close();
});

test("model and workspace discovery is filtered by the access key", async () => {
  const app = await fixture();
  try {
    const models = await (await request(app, "/v1/models")).json();
    assert.deepEqual(models.data.map((item) => item.id), ["fixture"]);

    const catalog = await (await request(app, "/allapi/v1/catalog")).json();
    assert.deepEqual(catalog.workspaces.map((item) => item.id), ["demo"]);
    assert.equal(catalog.models[0].capabilities.native, true);
    assert.equal(catalog.models[0].agent_version, "fixture-1.0");
    assert.equal(catalog.models[0].protocols.responses.client_tools, false);
    assert.equal(catalog.models[0].protocols.responses.tools_as_text, true);
    assert.equal(catalog.models[0].protocols.native.startup_configuration, "model_profile");
    assert.equal(catalog.models[0].protocols.native.frame_configuration, "agent_protocol_only");
    assert.equal(catalog.default_workspace, "demo");

    const anthropic = await request(app, "/v1/models", undefined, {
      authorization: "",
      "x-api-key": app.token,
      "anthropic-version": "2023-06-01",
    });
    const anthropicModels = await anthropic.json();
    assert.equal(anthropicModels.data[0].type, "model");
    assert.equal(anthropicModels.data[0].capabilities.image_input.supported, true);
  } finally {
    await app.cleanup();
  }
});

test("unverified Agent protocols expose Native but reject standard execution", async () => {
  const app = await fixture({ standardStatus: "unverified" });
  try {
    const catalog = await (await request(app, "/allapi/v1/catalog")).json();
    assert.equal(catalog.models[0].protocols.chat_completions.supported, false);
    assert.equal(catalog.models[0].standard_compatibility.status, "unverified");
    assert.equal(catalog.models[0].protocols.native.supported, true);

    const standard = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(standard.status, 409);
    assert.equal((await standard.json()).error.type, "agent_protocol_unverified");
  } finally {
    await app.cleanup();
  }
});

test("standard protocol certification is enforced per endpoint", async () => {
  const app = await fixture({
    standardProtocols: {
      chat_completions: { status: "verified" },
      responses: { status: "unverified", reason: "responses not certified" },
      messages: { status: "unverified", reason: "messages not certified" },
    },
  });
  try {
    const chat = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(chat.status, 200);

    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: "hi",
    });
    assert.equal(response.status, 409);

    const catalog = await (await request(app, "/allapi/v1/catalog")).json();
    assert.equal(catalog.models[0].protocols.chat_completions.supported, true);
    assert.equal(catalog.models[0].protocols.responses.supported, false);
  } finally {
    await app.cleanup();
  }
});

test("Chat Completions is strict, streams officially shaped chunks, and preserves usage", async () => {
  const app = await fixture();
  try {
    const invalid = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      allapi_workspace: "demo",
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /unknown parameter/i);

    const response = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "hello");
    assert.deepEqual(body.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.equal(app.runs[0].workspace.id, "demo");

    const streamed = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }, { "x-allapi-workspace": "demo" });
    const text = await streamed.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /data: \[DONE\]/);
    const chunks = text.split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(chunks.at(-1).choices, []);
    assert.deepEqual(chunks.at(-1).usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.equal(chunks.at(-2).usage, null);
  } finally {
    await app.cleanup();
  }
});

test("Chat streaming fails explicitly when requested usage is unavailable", async () => {
  const app = await fixture();
  const original = app.registry.get("fixture");
  app.registry.register("fixture", {
    capabilities: original.capabilities,
    verifyStandard: original.verifyStandard,
    async *run() {
      yield { type: "text.delta", delta: "hello" };
      yield { type: "completed", sessionId: "without-usage" };
    },
  });
  try {
    const response = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const body = await response.text();
    assert.match(body, /agent_usage_unavailable/);
    assert.doesNotMatch(body, /data: \[DONE\]/);
  } finally {
    await app.cleanup();
  }
});

test("Responses retrieval preserves final output and continuation reuses the agent session", async () => {
  const app = await fixture();
  try {
    const first = await request(app, "/v1/responses", {
      model: "fixture",
      input: "first private prompt",
    }, { "x-allapi-workspace": "demo" });
    const firstBody = await first.json();
    assert.equal(firstBody.object, "response");
    assert.equal(firstBody.output[0].content[0].text, "hello");
    const retrieved = await request(app, `/v1/responses/${firstBody.id}`);
    const retrievedBody = await retrieved.json();
    assert.deepEqual(retrievedBody.output, firstBody.output);
    assert.deepEqual(retrievedBody.usage, firstBody.usage);

    const second = await request(app, "/v1/responses", {
      model: "fixture",
      input: "second private prompt",
      previous_response_id: firstBody.id,
    }, { "x-allapi-workspace": "demo" });
    assert.equal(second.status, 200);
    assert.equal(app.runs[1].sessionId, "agent-session-1");

    const metadata = JSON.stringify(app.responses.snapshot());
    assert.doesNotMatch(metadata, /private prompt/);

    const ephemeral = await request(app, "/v1/responses", {
      model: "fixture",
      input: "temporary",
      store: false,
      metadata: { client: "test" },
    });
    const ephemeralBody = await ephemeral.json();
    assert.deepEqual(ephemeralBody.metadata, { client: "test" });
    const missing = await request(app, `/v1/responses/${ephemeralBody.id}`);
    assert.equal(missing.status, 404);
  } finally {
    await app.cleanup();
  }
});

test("store:false Responses are never addressable through lifecycle endpoints", async () => {
  const app = await fixture({ standardCompletionDelay: 100 });
  try {
    const streamed = await request(app, "/v1/responses", {
      model: "fixture",
      input: "temporary",
      stream: true,
      store: false,
    });
    const reader = streamed.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    const createdLine = firstChunk.split("\n").find((line) =>
      line.startsWith("data: ") && line.includes('"response.created"'));
    const id = JSON.parse(createdLine.slice(6)).response.id;

    const lookup = await request(app, `/v1/responses/${id}`);
    assert.equal(lookup.status, 404);

    while (!(await reader.read()).done) {}
  } finally {
    await app.cleanup();
  }
});

test("an Agent stream ending without an official terminal event fails the request", async () => {
  const app = await fixture();
  const original = app.registry.get("fixture");
  app.registry.register("fixture", {
    capabilities: original.capabilities,
    verifyStandard: original.verifyStandard,
    async *run() {
      yield { type: "text.delta", delta: "unfinished" };
    },
  });
  try {
    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: "hello",
    });
    assert.equal(response.status, 500);
    assert.equal(app.activity().standard, 0);
  } finally {
    await app.cleanup();
  }
});

test("client tools are passed as text and never become a tool-call control loop", async () => {
  const app = await fixture();
  try {
    const chat = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "weather" }],
      tools: [{
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      }],
      tool_choice: {
        type: "function",
        function: { name: "weather" },
      },
      parallel_tool_calls: false,
    }, { "x-allapi-workspace": "demo" });
    const chatBody = await chat.json();
    assert.equal(chatBody.choices[0].finish_reason, "stop");
    assert.equal(chatBody.choices[0].message.content, "hello");
    assert.deepEqual(app.runs[0].tools, []);
    const toolContext = app.runs[0].input.map((block) => block.text ?? "").join("\n");
    assert.match(toolContext, /"name":"weather"/);
    assert.match(toolContext, /"parallel_tool_calls":false/);

    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: "weather",
      tools: [{
        type: "function",
        name: "weather",
        description: "Get weather",
        parameters: { type: "object" },
      }],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: false,
    }, { "x-allapi-workspace": "demo" });
    const responseBody = await response.json();
    assert.equal(responseBody.parallel_tool_calls, false);
    assert.equal(responseBody.output[0].type, "message");
    assert.equal(responseBody.output[0].content[0].text, "hello");
  } finally {
    await app.cleanup();
  }
});

test("standard APIs return interactive Agent requests as text without approving them", async () => {
  const app = await fixture();
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
    verifyStandard: app.registry.get("fixture").verifyStandard,
    async *run() {
      yield {
        type: "interaction",
        payload: {
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { command: "touch approval.txt", reason: "test" },
        },
      };
      yield {
        type: "interrupted",
        sessionId: "approval-session",
        usage: { input_tokens: 4, output_tokens: 1 },
      };
    },
    openNative: app.registry.get("fixture").openNative,
  });
  try {
    const chat = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "do it" }],
    });
    const chatBody = await chat.json();
    assert.equal(chatBody.choices[0].finish_reason, "stop");
    assert.match(chatBody.choices[0].message.content, /requestApproval/);
    assert.match(chatBody.choices[0].message.content, /touch approval\.txt/);

    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: "do it",
    });
    const responseBody = await response.json();
    assert.equal(responseBody.status, "incomplete");
    assert.equal(responseBody.incomplete_details.reason, "agent_interrupted");
    assert.match(responseBody.output[0].content[0].text, /requestApproval/);
  } finally {
    await app.cleanup();
  }
});

test("Anthropic Messages uses Anthropic auth and error dialect", async () => {
  const app = await fixture();
  try {
    const response = await request(app, "/v1/messages", {
      model: "fixture",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }, {
      authorization: "",
      "x-api-key": app.token,
      "anthropic-version": "2023-06-01",
      "x-allapi-workspace": "demo",
    });
    const body = await response.json();
    assert.equal(body.type, "message");
    assert.equal(body.content[0].text, "hello");
    assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 2 });

    const streamed = await request(app, "/v1/messages", {
      model: "fixture",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }, {
      authorization: "",
      "x-api-key": app.token,
      "anthropic-version": "2023-06-01",
    });
    const events = (await streamed.text()).split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map((event) => event.type), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.deepEqual(events[0].message.usage, { input_tokens: 3, output_tokens: 0 });
    assert.deepEqual(events.at(-2).usage, { output_tokens: 2 });

    const bad = await request(app, "/v1/messages", {
      model: "fixture",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      unsupported: true,
    }, {
      authorization: "",
      "x-api-key": app.token,
      "anthropic-version": "2023-06-01",
    });
    assert.equal((await bad.json()).type, "error");
  } finally {
    await app.cleanup();
  }
});

test("native WebSocket forwards each official frame byte-for-byte without an envelope", async () => {
  const app = await fixture();
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const socket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture`,
      { headers: { authorization: `Bearer ${app.nativeToken}` } },
    );
    const messages = [];
    socket.on("message", (data) => messages.push(data.toString()));
    await once(socket, "open");
    while (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages[0], '{"type":"agent.ready","session_id":"native-1"}');

    const official = '{"method":"turn/steer","params":{"input":"now test"}}';
    socket.send(official);
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages[1], official);
    assert.equal(app.nativeInputs[0].message.toString(), official);
    socket.close();
    await once(socket, "close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.nativeCloses.length, 1);
    assert.equal(app.activity().native, 0);
  } finally {
    await app.cleanup();
  }
});

test("disconnecting while Native starts still closes the eventual Agent transport", async () => {
  const app = await fixture({ nativeOpenDelay: 50 });
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const socket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture`,
      { headers: { authorization: `Bearer ${app.nativeToken}` } },
    );
    await once(socket, "open");
    socket.close();
    await once(socket, "close");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.nativeCloses.length, 1);
    assert.equal(app.activity().native, 0);
  } finally {
    await app.cleanup();
  }
});

test("Native frames arriving during Agent startup are delivered in order", async () => {
  const app = await fixture({ nativeOpenDelay: 50 });
  let socket;
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    socket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture`,
      { headers: { authorization: `Bearer ${app.nativeToken}` } },
    );
    await once(socket, "open");
    socket.send('{"id":"early"}');
    socket.send('{"id":"second"}');
    for (let attempt = 0; attempt < 50 && app.nativeInputs.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      app.nativeInputs.map(({ message }) => message.toString()),
      ['{"id":"early"}', '{"id":"second"}'],
    );
  } finally {
    socket?.close();
    await app.cleanup();
  }
});

test("Native startup input buffering is bounded", async () => {
  const app = await fixture({
    nativeOpenDelay: 50,
    maxNativeFrameBytes: 100,
    maxNativeBufferedBytes: 10,
    nativeSendsReady: false,
  });
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const socket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture`,
      { headers: { authorization: `Bearer ${app.nativeToken}` } },
    );
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send("12345678");
    socket.send("abcdefgh");
    const [code] = await closed;
    assert.equal(code, 1009);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.nativeCloses.length, 1);
  } finally {
    await app.cleanup();
  }
});

test("native keys are isolated from standard APIs and revocation closes browser-authenticated sockets", async () => {
  const app = await fixture();
  try {
    const denied = await fetch(`${app.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${app.nativeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "fixture", input: "no" }),
    });
    assert.equal(denied.status, 403);

    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const accessSocket = new WebSocket(`${wsUrl}/v1/native/sessions?model=fixture`, {
      headers: { authorization: `Bearer ${app.token}` },
    });
    const [accessError] = await once(accessSocket, "error");
    assert.match(accessError.message, /403/);

    const nativeSocket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture`,
      ["allapi.native", app.nativeToken],
    );
    await once(nativeSocket, "open");
    const closed = once(nativeSocket, "close");
    await app.revokeKey(app.nativeKeyId);
    const [code] = await closed;
    assert.equal(code, 1008);
  } finally {
    await app.cleanup();
  }
});

test("native transport enforces connection and frame limits without inspecting messages", async () => {
  const app = await fixture({ maxNativeConnections: 1, maxNativeFrameBytes: 64 });
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const first = new WebSocket(`${wsUrl}/v1/native/sessions?model=fixture`, {
      headers: { authorization: `Bearer ${app.nativeToken}` },
    });
    await once(first, "open");

    const second = new WebSocket(`${wsUrl}/v1/native/sessions?model=fixture`, {
      headers: { authorization: `Bearer ${app.nativeToken}` },
    });
    const [limitError] = await once(second, "error");
    assert.match(limitError.message, /429/);

    const closed = once(first, "close");
    first.send("x".repeat(65));
    const [code] = await closed;
    assert.equal(code, 1009);
  } finally {
    await app.cleanup();
  }
});

test("HTTP disconnect does not cancel a task", async () => {
  const app = await fixture();
  let aborted = false;
  let completed = false;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
    verifyStandard: app.registry.get("fixture").verifyStandard,
    async *run({ signal }) {
      signal.addEventListener("abort", () => { aborted = true; });
      started();
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield { type: "text.delta", delta: "finished" };
      yield { type: "completed", sessionId: "still-running" };
      completed = true;
    },
    openNative: app.registry.get("fixture").openNative,
  });

  try {
    const url = new URL("/v1/responses", app.baseUrl);
    const body = JSON.stringify({ model: "fixture", input: "work" });
    const client = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${app.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-allapi-workspace": "demo",
      },
    });
    client.on("error", () => {});
    client.end(body);
    await didStart;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(aborted, false);
    assert.equal(completed, true);
  } finally {
    await app.cleanup();
  }
});

test("explicit Responses cancellation aborts the owned agent turn", async () => {
  const app = await fixture();
  let aborted = false;
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
    verifyStandard: app.registry.get("fixture").verifyStandard,
    async *run({ signal }) {
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      yield {
        type: "completed",
        sessionId: "late-session",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
    openNative: app.registry.get("fixture").openNative,
  });
  try {
    const streamed = await request(app, "/v1/responses", {
      model: "fixture",
      input: "work",
      stream: true,
    }, { "x-allapi-workspace": "demo" });
    const reader = streamed.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const responseId = JSON.parse(first.match(/data: (.+)\n/)[1]).response.id;
    const cancelled = await request(app, `/v1/responses/${responseId}/cancel`, {});
    assert.equal((await cancelled.json()).status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborted, true);
    const retrieved = await request(app, `/v1/responses/${responseId}`);
    assert.equal((await retrieved.json()).status, "cancelled");
    let tail = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      tail += new TextDecoder().decode(part.value);
    }
    assert.doesNotMatch(tail, /response\.completed/);
  } finally {
    await app.cleanup();
  }
});

test("streaming Responses persist an Agent failure as a terminal failed state", async () => {
  const app = await fixture();
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
    verifyStandard: app.registry.get("fixture").verifyStandard,
    async *run() {
      yield { type: "text.delta", delta: "partial" };
      const error = new Error("fixture exploded");
      error.code = "fixture_failed";
      throw error;
    },
    openNative: app.registry.get("fixture").openNative,
  });
  try {
    const streamed = await request(app, "/v1/responses", {
      model: "fixture",
      input: "work",
      stream: true,
    });
    const text = await streamed.text();
    const responseId = JSON.parse(text.match(/data: (.+)\n/)[1]).response.id;
    assert.match(text, /"type":"error"/);

    const retrieved = await request(app, `/v1/responses/${responseId}`);
    const body = await retrieved.json();
    assert.equal(body.status, "failed");
    assert.equal(body.error.code, "fixture_failed");
  } finally {
    await app.cleanup();
  }
});

test("global concurrency fails busy immediately instead of creating an All API queue", async () => {
  const app = await fixture({ maxConcurrent: 1 });
  let release;
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
    verifyStandard: app.registry.get("fixture").verifyStandard,
    async *run() {
      await new Promise((resolve) => { release = resolve; });
      yield { type: "completed", sessionId: "done" };
    },
    openNative: app.registry.get("fixture").openNative,
  });
  try {
    const first = await request(app, "/v1/responses", {
      model: "fixture",
      input: "first",
      stream: true,
    }, { "x-allapi-workspace": "demo" });
    await first.body.getReader().read();

    const second = await request(app, "/v1/responses", {
      model: "fixture",
      input: "second",
    }, { "x-allapi-workspace": "demo" });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.type, "server_busy");
    release();
  } finally {
    release?.();
    await app.cleanup();
  }
});

test("Files API stores explicit files and blocks cross-key access", async () => {
  const app = await fixture();
  try {
    const form = new FormData();
    form.set("purpose", "assistants");
    form.set("file", new Blob(["hello file"], { type: "text/plain" }), "hello.txt");
    const created = await fetch(`${app.baseUrl}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
      body: form,
    });
    const file = await created.json();
    assert.equal(file.filename, "hello.txt");

    const content = await fetch(`${app.baseUrl}/v1/files/${file.id}/content`, {
      headers: { authorization: `Bearer ${app.token}` },
    });
    assert.equal(await content.text(), "hello file");

    const forbidden = await fetch(`${app.baseUrl}/v1/files/${file.id}`, {
      headers: { authorization: `Bearer ${app.otherToken}` },
    });
    assert.equal(forbidden.status, 404);

    const anthropicList = await fetch(`${app.baseUrl}/v1/files`, {
      headers: {
        "x-api-key": app.token,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
      },
    });
    const anthropicBody = await anthropicList.json();
    assert.equal(anthropicBody.data[0].type, "file");
    assert.equal(anthropicBody.data[0].size_bytes, 10);
  } finally {
    await app.cleanup();
  }
});

test("standard file inputs cannot read arbitrary local paths", async () => {
  const app = await fixture();
  try {
    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: [{
        type: "input_file",
        file_url: path.join(app.directory, "secret.txt"),
      }],
    });
    assert.equal(response.status, 400);
    assert.equal(app.runs.length, 0);
  } finally {
    await app.cleanup();
  }
});
