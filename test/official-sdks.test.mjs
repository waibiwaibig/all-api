import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../src/agents.mjs";
import { createApiKey } from "../src/core.mjs";
import { createAllApiServer } from "../src/server.mjs";

test("official SDKs consume All API standard responses", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-official-sdks-"));
  const { token, record } = await createApiKey({
    kind: "access",
    name: "official-sdk-test",
    models: ["fixture"],
    workspaces: ["demo"],
    defaultWorkspace: "demo",
  });
  const capabilities = {
    input: ["text"],
    tools: ["agent"],
    approvals: false,
    continuation: true,
    native: false,
    usage: true,
  };
  const registry = new AgentRegistry().register("fixture", {
    capabilities,
    async verifyStandard() {
      return {
        status: "verified",
        evidence: "deterministic-fixture",
        protocols: Object.fromEntries(
          ["chat_completions", "responses", "messages"].map((protocol) => [
            protocol,
            { status: "verified", evidence: "deterministic-fixture" },
          ]),
        ),
      };
    },
    async *run({ sessionId }) {
      yield { type: "text.delta", delta: "official SDK" };
      yield {
        type: "completed",
        sessionId: sessionId ?? "fixture-session",
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    },
  });
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
    models: { fixture: { agent: "fixture", source: "local", workspace: "demo" } },
    workspaces: { demo: { path: directory } },
    keys: { [record.id]: record },
    connectors: {
      fixture: {
        command: process.execPath,
        args: [],
        capabilities,
      },
    },
  };
  const app = await createAllApiServer({ config, registry, dataDirectory: directory });
  await app.listen();
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const openai = new OpenAI({ apiKey: token, baseURL: `${baseUrl}/v1` });
  const anthropic = new Anthropic({ apiKey: token, baseURL: baseUrl });

  try {
    const chat = await openai.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chatChunks = [];
    for await (const chunk of chat) chatChunks.push(chunk);
    assert.equal(chatChunks.at(-1).choices.length, 0);
    assert.equal(chatChunks.at(-1).usage.total_tokens, 5);

    const created = await openai.responses.create({ model: "fixture", input: "hello" });
    const retrieved = await openai.responses.retrieve(created.id);
    assert.equal(retrieved.output_text, "official SDK");
    assert.deepEqual(retrieved.output, created.output);

    const messages = await anthropic.messages.create({
      model: "fixture",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const eventTypes = [];
    for await (const event of messages) eventTypes.push(event.type);
    assert.deepEqual(eventTypes, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
