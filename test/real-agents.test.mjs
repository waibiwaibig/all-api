import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { WebSocket } from "ws";
import { createDefaultRegistry } from "../src/agents.mjs";
import { createApiKey } from "../src/core.mjs";
import { createAllApiServer } from "../src/server.mjs";

test("official SDKs reach real certified Codex standard APIs", {
  skip: process.env.ALL_API_REAL_AGENTS !== "1",
  timeout: 180_000,
}, async (t) => {
  const harness = await standardHarness("codex", t);
  if (!harness) return;
  const { openai, anthropic } = harness;
  try {
    const chat = await openai.chat.completions.create({
      model: "codex",
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let chatText = "";
    let chatUsage;
    for await (const chunk of chat) {
      chatText += chunk.choices[0]?.delta?.content ?? "";
      chatUsage = chunk.usage ?? chatUsage;
    }
    assert.ok(chatText.length > 0);
    assert.ok(chatUsage?.total_tokens > 0);

    const response = await openai.responses.create({
      model: "codex",
      input: "Reply with exactly OK. Do not use tools.",
    });
    assert.equal(response.status, "completed");
    assert.ok(response.output_text.length > 0);

    const codexMessage = await anthropic.messages.create({
      model: "codex",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
    });
    assert.equal(codexMessage.type, "message");
    assert.ok(codexMessage.content.some(
      (block) => block.type === "text" && block.text.length > 0,
    ));
    assert.ok(codexMessage.usage.input_tokens > 0);
  } finally {
    await harness.cleanup();
  }
});

test("official SDKs reach real certified Claude standard APIs", {
  skip: process.env.ALL_API_REAL_AGENTS !== "1",
  timeout: 180_000,
}, async (t) => {
  const harness = await standardHarness("claude", t);
  if (!harness) return;
  const { openai, anthropic } = harness;
  try {
    const message = await anthropic.messages.create({
      model: "claude",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
    });
    assert.equal(message.type, "message");
    assert.ok(message.content.some((block) => block.type === "text" && block.text.length > 0));
    assert.ok(message.usage.input_tokens > 0);

    const chat = await openai.chat.completions.create({
      model: "claude",
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
    });
    assert.ok((chat.choices[0]?.message.content ?? "").length > 0);

    const response = await openai.responses.create({
      model: "claude",
      input: "Reply with exactly OK. Do not use tools.",
    });
    assert.equal(response.status, "completed");
    assert.ok(response.output_text.length > 0);
  } finally {
    await harness.cleanup();
  }
});

test("real Codex and Claude Native protocols cross the WebSocket byte bridge", {
  skip: process.env.ALL_API_REAL_AGENTS !== "1",
  timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-real-native-"));
  const { token, record } = await createApiKey({
    kind: "native",
    name: "real-native-certification",
  });
  const config = {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: 0,
      maxConcurrent: 1,
      maxNativeConnections: 2,
      maxNativeFrameBytes: 1_048_576,
      maxNativeBufferedBytes: 4_194_304,
      responseRetentionDays: 1,
    },
    models: {
      codex: { agent: "codex", source: "local", workspace: "certification" },
      claude: {
        agent: "claude",
        source: "managed",
        workspace: "certification",
        overrides: {
          native: {
            args: [
              "-p",
              "--output-format", "stream-json",
              "--verbose",
              "--input-format", "stream-json",
              "--permission-prompt-tool", "stdio",
              "--setting-sources=",
            ],
          },
        },
      },
    },
    workspaces: { certification: { path: directory } },
    keys: { [record.id]: record },
    connectors: {},
  };
  const app = await createAllApiServer({
    config,
    registry: createDefaultRegistry(config),
    dataDirectory: directory,
  });
  await app.listen();
  const { port } = app.server.address();
  const baseUrl = `ws://127.0.0.1:${port}/v1/native/sessions`;

  try {
    const codex = await nativeSocket(`${baseUrl}?model=codex`, token);
    codex.socket.send(JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientInfo: { name: "all-api-test", version: "0.4.0" } },
    }));
    await waitForNative(codex.messages, (message) => message.id === "initialize");
    codex.socket.send(JSON.stringify({ method: "initialized", params: {} }));
    codex.socket.send(JSON.stringify({
      id: "thread",
      method: "thread/start",
      params: { cwd: directory, approvalPolicy: "never", sandbox: "read-only" },
    }));
    const thread = await waitForNative(codex.messages, (message) => message.id === "thread");
    codex.socket.send(JSON.stringify({
      id: "turn",
      method: "turn/start",
      params: {
        threadId: thread.result.thread.id,
        input: [{ type: "text", text: "Reply with exactly OK. Do not use tools." }],
      },
    }));
    await waitForNative(
      codex.messages,
      (message) => message.method === "turn/completed",
      120_000,
    );
    codex.socket.close();

    const claude = await nativeSocket(`${baseUrl}?model=claude`, token);
    claude.socket.send(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "Reply with exactly OK. Do not use tools.",
      },
      parent_tool_use_id: null,
    }));
    const result = await waitForNative(
      claude.messages,
      (message) => message.type === "result",
      120_000,
    );
    assert.equal(result.subtype, "success");
    claude.socket.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function standardHarness(agent, t) {
  const directory = await mkdtemp(path.join(tmpdir(), `all-api-real-${agent}-`));
  const { token, record } = await createApiKey({
    kind: "access",
    name: `${agent}-certification`,
    models: [agent],
    workspaces: ["certification"],
    defaultWorkspace: "certification",
  });
  const profile = agent === "codex"
    ? {
        agent,
        source: "managed",
        workspace: "certification",
        overrides: { thread: { approvalPolicy: "never", sandbox: "read-only" } },
      }
    : {
        agent,
        source: "managed",
        workspace: "certification",
        overrides: { options: { permissionMode: "dontAsk", maxTurns: 1 } },
      };
  const config = {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: 0,
      maxConcurrent: 1,
      maxNativeConnections: 1,
      maxNativeFrameBytes: 1_048_576,
      maxNativeBufferedBytes: 4_194_304,
      responseRetentionDays: 1,
    },
    models: { [agent]: profile },
    workspaces: { certification: { path: directory } },
    keys: { [record.id]: record },
    connectors: {},
  };
  const registry = createDefaultRegistry(config);
  const compatibility = await registry.get(agent).verifyStandard();
  if (compatibility.status !== "verified") {
    t.skip(compatibility.reason);
    await registry.close();
    await rm(directory, { recursive: true, force: true });
    return undefined;
  }
  const app = await createAllApiServer({ config, registry, dataDirectory: directory });
  await app.listen();
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    openai: new OpenAI({ apiKey: token, baseURL: `${baseUrl}/v1` }),
    anthropic: new Anthropic({ apiKey: token, baseURL: baseUrl }),
    async cleanup() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function nativeSocket(url, token) {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitForNative(messages, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for real Native Agent event");
}
