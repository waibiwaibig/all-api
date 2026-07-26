import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let threadParams;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.argv.includes("--ignore-all")) return;
  if (message.method === "initialize") {
    reply(message.id, { userAgent: "fake-codex" });
  } else if (message.method === "thread/start") {
    threadParams = message.params;
    reply(message.id, { thread: { id: "codex-thread-1" } });
  } else if (message.method === "thread/resume") {
    reply(message.id, { thread: { id: message.params.threadId } });
  } else if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1" } });
    if (process.argv.includes("--exit-after-turn")) {
      setImmediate(() => process.exit(7));
      return;
    }
    if (process.argv.includes("--echo-params")) {
      emit("item/agentMessage/delta", {
        threadId: message.params.threadId,
        turnId: "turn-1",
        itemId: "item-params",
        delta: JSON.stringify({ thread: threadParams, turn: message.params }),
      });
    }
    if (process.argv.includes("--request-approval")) {
      process.stdout.write(`${JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "touch approval.txt",
          reason: "test approval",
        },
      })}\n`);
      return;
    }
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
    emit("thread/tokenUsage/updated", {
      threadId: message.params.threadId,
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens: 8,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 10,
        },
        last: {
          inputTokens: 8,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 10,
        },
        modelContextWindow: 200_000,
      },
    });
    emit("turn/completed", {
      threadId: message.params.threadId,
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
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
