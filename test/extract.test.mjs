import test from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletion,
  extractClaudeText,
  extractCodexText,
  messagesToPrompt,
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
