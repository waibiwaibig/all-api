import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createAccessKey } from "../src/core.mjs";
import { AgentRegistry } from "../src/agents.mjs";
import { createAllApiServer } from "../src/server.mjs";

async function fixture({ maxConcurrent = 4 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-server-"));
  const { token, record } = await createAccessKey({
    name: "test",
    models: ["fixture"],
    workspaces: ["demo"],
  });
  const { token: otherToken, record: otherRecord } = await createAccessKey({
    name: "other",
    models: ["fixture"],
    workspaces: ["demo"],
  });
  const runs = [];
  const nativeInputs = [];
  const adapter = {
    capabilities: {
      input: ["text", "image", "file"],
      tools: ["client"],
      approvals: true,
      continuation: true,
      native: true,
      usage: true,
    },
    async *run(request) {
      runs.push(request);
      if (request.tools.length) {
        const tool = request.tools[0].function ?? request.tools[0];
        yield {
          type: "client.tool",
          id: "call_weather",
          name: tool.name,
          arguments: { city: "Shanghai" },
        };
        yield {
          type: "completed",
          sessionId: request.sessionId ?? "agent-session-1",
          usage: { input_tokens: 3, output_tokens: 2 },
        };
        return;
      }
      yield { type: "text.delta", delta: "hel" };
      yield { type: "text.delta", delta: "lo" };
      yield {
        type: "completed",
        sessionId: request.sessionId ?? "agent-session-1",
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    },
    async openNative({ send, sessionId }) {
      send({ type: "agent.ready", session_id: sessionId ?? "native-1" });
      return {
        async receive(message) {
          nativeInputs.push(message);
          send({ type: "agent.echo", payload: message });
        },
        async close() {},
      };
    },
  };
  const registry = new AgentRegistry();
  registry.register("fixture", adapter);
  const config = {
    version: 2,
    server: { host: "127.0.0.1", port: 0, maxConcurrent },
    models: { fixture: { agent: "fixture", source: "local" } },
    workspaces: {
      demo: { path: directory },
      hidden: { path: "/tmp/hidden" },
    },
    keys: { [record.id]: record, [otherRecord.id]: otherRecord },
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
    runs,
    nativeInputs,
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

test("model and workspace discovery is filtered by the access key", async () => {
  const app = await fixture();
  try {
    const models = await (await request(app, "/v1/models")).json();
    assert.deepEqual(models.data.map((item) => item.id), ["fixture"]);

    const catalog = await (await request(app, "/allapi/v1/catalog")).json();
    assert.deepEqual(catalog.workspaces.map((item) => item.id), ["demo"]);
    assert.equal(catalog.models[0].capabilities.native, true);

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
    }, { "x-allapi-workspace": "demo" });
    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "hello");
    assert.deepEqual(body.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });

    const streamed = await request(app, "/v1/chat/completions", {
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }, { "x-allapi-workspace": "demo" });
    const text = await streamed.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await app.cleanup();
  }
});

test("Responses continuation stores only opaque metadata and reuses the agent session", async () => {
  const app = await fixture();
  try {
    const first = await request(app, "/v1/responses", {
      model: "fixture",
      input: "first private prompt",
    }, { "x-allapi-workspace": "demo" });
    const firstBody = await first.json();
    assert.equal(firstBody.object, "response");
    assert.equal(firstBody.output[0].content[0].text, "hello");

    const second = await request(app, "/v1/responses", {
      model: "fixture",
      input: "second private prompt",
      previous_response_id: firstBody.id,
    }, { "x-allapi-workspace": "demo" });
    assert.equal(second.status, 200);
    assert.equal(app.runs[1].sessionId, "agent-session-1");

    const metadata = JSON.stringify(app.responses.snapshot());
    assert.doesNotMatch(metadata, /private prompt/);
  } finally {
    await app.cleanup();
  }
});

test("client tools use each standard protocol's official output shape", async () => {
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
    }, { "x-allapi-workspace": "demo" });
    const chatBody = await chat.json();
    assert.equal(chatBody.choices[0].finish_reason, "tool_calls");
    assert.equal(chatBody.choices[0].message.tool_calls[0].function.name, "weather");

    const response = await request(app, "/v1/responses", {
      model: "fixture",
      input: "weather",
      tools: [{
        type: "function",
        name: "weather",
        description: "Get weather",
        parameters: { type: "object" },
      }],
    }, { "x-allapi-workspace": "demo" });
    const responseBody = await response.json();
    assert.equal(responseBody.output[0].type, "function_call");
    assert.equal(responseBody.output[0].name, "weather");
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

test("native WebSocket keeps the official payload unchanged in a thin envelope", async () => {
  const app = await fixture();
  try {
    const wsUrl = app.baseUrl.replace("http:", "ws:");
    const socket = new WebSocket(
      `${wsUrl}/v1/native/sessions?model=fixture&workspace=demo`,
      { headers: { authorization: `Bearer ${app.token}` } },
    );
    const messages = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, "open");
    while (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages[0].payload.type, "agent.ready");

    const official = { method: "turn/steer", params: { input: "now test" } };
    socket.send(JSON.stringify({ type: "agent.input", payload: official }));
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(messages[1].payload.payload, official);
    socket.close();
    await once(socket, "close");
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
    async *run({ signal }) {
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
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
    await reader.cancel();
  } finally {
    await app.cleanup();
  }
});

test("global concurrency fails busy immediately instead of creating an All API queue", async () => {
  const app = await fixture({ maxConcurrent: 1 });
  let release;
  app.registry.register("fixture", {
    capabilities: app.registry.get("fixture").capabilities,
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
