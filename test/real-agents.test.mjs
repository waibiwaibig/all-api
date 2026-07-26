import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createDefaultRegistry } from "../src/agents.mjs";
import { createApiKey } from "../src/core.mjs";
import { createAllApiServer } from "../src/server.mjs";

test("official SDKs reach real certified Agents", {
  skip: process.env.ALL_API_REAL_AGENTS !== "1",
  timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "all-api-real-agents-"));
  const { token, record } = await createApiKey({
    kind: "access",
    name: "real-agent-certification",
    models: ["codex", "claude"],
    workspaces: ["certification"],
    defaultWorkspace: "certification",
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
    models: {
      codex: {
        agent: "codex",
        source: "managed",
        workspace: "certification",
        overrides: {
          thread: { approvalPolicy: "never", sandbox: "read-only" },
        },
      },
      claude: {
        agent: "claude",
        source: "managed",
        workspace: "certification",
        overrides: {
          options: { permissionMode: "dontAsk", maxTurns: 1 },
        },
      },
    },
    workspaces: { certification: { path: directory } },
    keys: { [record.id]: record },
    connectors: {},
  };
  const registry = createDefaultRegistry(config);
  const app = await createAllApiServer({ config, registry, dataDirectory: directory });
  await app.listen();
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const openai = new OpenAI({ apiKey: token, baseURL: `${baseUrl}/v1` });
  const anthropic = new Anthropic({ apiKey: token, baseURL: baseUrl });

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

    const message = await anthropic.messages.create({
      model: "claude",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
    });
    assert.equal(message.type, "message");
    assert.ok(message.content.some((block) => block.type === "text" && block.text.length > 0));
    assert.ok(message.usage.input_tokens > 0);

    const claudeChat = await openai.chat.completions.create({
      model: "claude",
      messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
    });
    assert.ok((claudeChat.choices[0]?.message.content ?? "").length > 0);

    const claudeResponse = await openai.responses.create({
      model: "claude",
      input: "Reply with exactly OK. Do not use tools.",
    });
    assert.equal(claudeResponse.status, "completed");
    assert.ok(claudeResponse.output_text.length > 0);

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
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
