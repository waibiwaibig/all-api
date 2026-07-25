import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { userAgent: "fake-codex" });
  } else if (message.method === "thread/start") {
    reply(message.id, { thread: { id: "codex-thread-1" } });
  } else if (message.method === "thread/resume") {
    reply(message.id, { thread: { id: message.params.threadId } });
  } else if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1" } });
    emit("item/agentMessage/delta", {
      threadId: message.params.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: "official ",
    });
    emit("item/agentMessage/delta", {
      threadId: message.params.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: "codex",
    });
    emit("turn/completed", {
      threadId: message.params.threadId,
      turn: {
        id: "turn-1",
        status: "completed",
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    });
  } else if (message.id !== undefined) {
    reply(message.id, { echo: message });
  } else if (message.method !== "initialized") {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function emit(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
