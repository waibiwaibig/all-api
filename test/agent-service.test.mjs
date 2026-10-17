import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import {
  SendMessageRequest,
  GetTaskRequest,
  TaskState as S,
  AgentCard,
} from "@a2a-js/sdk";
import { createApiKey } from "../src/core.mjs";
import { AgentRegistry } from "../src/agents.mjs";
import { createAllApiServer } from "../src/server.mjs";
import { EXECUTION_EXTENSION } from "../src/agent-service.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "execution-test-"));
  const key = await createApiKey({
    kind: "access",
    name: "secretary",
    models: ["fixture"],
    workspaces: ["work"],
    defaultWorkspace: "work",
  });
  const runs = [];
  let wait, verification;
  const adapter = {
    capabilities: { input: ["text"] },
    async verifyStandard() {
      if (verification) await verification;
      return { protocols: { responses: { status: "verified" } } };
    },
    async *run(r) {
      runs.push(r);
      r.onSession?.("engine-thread");
      if (wait) await wait;
      if (r.responseSchema) yield { type: "structured", data: { reply: "structured result" } };
      yield { type: "text.delta", delta: "reply:" + r.input[0].text };
      yield { type: "completed", sessionId: "engine-thread" };
    },
  };
  const config = {
    version: 4,
    server: {
      host: "127.0.0.1",
      port: 0,
      maxConcurrent: 1,
      maxNativeConnections: 1,
      maxNativeFrameBytes: 1024,
      maxNativeBufferedBytes: 1024,
      responseRetentionDays: 30,
    },
    models: { fixture: { agent: "codex", source: "local", workspace: "work" } },
    workspaces: { work: { path: directory } },
    keys: { [key.record.id]: key.record },
    connectors: {},
  };
  let app, base;
  const start = async () => {
    const registry = new AgentRegistry().register("codex", adapter);
    app = await createAllApiServer({
      config,
      registry,
      dataDirectory: directory,
    });
    const address = await app.listen();
    base = `http://127.0.0.1:${address.port}`;
  };
  await start();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const authFetch = (url, init) =>
    fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        authorization: `Bearer ${key.token}`,
        "a2a-version": "1.0",
        "a2a-extensions": EXECUTION_EXTENSION,
      },
    });
  const client = async () => {
    const r = await authFetch(`${base}/.well-known/agent-card.json`);
    assert.equal(r.status, 200);
    return new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
    }).createFromAgentCard(AgentCard.fromJSON(await r.json()));
  };
  return {
    config,
    runs,
    client,
    get app() {
      return app;
    },
    get base() {
      return base;
    },
    authFetch,
    restart: async () => {
      await app.close();
      await start();
    },
    holdVerification: () => {
      let release;
      verification = new Promise((r) => {
        release = r;
      });
      return () => {
        verification = null;
        release();
      };
    },
    hold: () => {
      let release;
      wait = new Promise((r) => {
        release = r;
      });
      return () => {
        wait = null;
        release();
      };
    },
  };
}
const message = (id, text, contextId = "application-context") =>
  SendMessageRequest.fromJSON({
    message: { messageId: id, role: "ROLE_USER", contextId, parts: [{ text }], metadata: { execution: { agent: "fixture" } } },
    configuration: { returnImmediately: true },
  });
async function final(client, id) {
  for (let i = 0; i < 400; i++) {
    const task = await client.getTask(GetTaskRequest.fromJSON({ id }));
    if (![1, 2].includes(task.status.state)) return task;
    await delay(10);
  }
  throw new Error("Task did not complete");
}

test("official A2A client: durable duplicate, conflict, restart and one continued context", async (t) => {
  const f = await fixture(t);
  let client = await f.client();
  const input = message(randomUUID(), "first");
  const accepted = await client.sendMessage(input);
  assert.ok(accepted.id);
  const first = await final(client, accepted.id);
  assert.equal(first.status.state, S.TASK_STATE_COMPLETED);
  assert.equal(first.artifacts[0].parts[0].content.value, "reply:first");
  assert.equal((await client.sendMessage(input)).id, first.id);
  await assert.rejects(() =>
    client.sendMessage(message(input.message.messageId, "changed")),
  );
  assert.equal(f.runs.length, 1);
  await f.restart();
  client = await f.client();
  assert.equal((await client.sendMessage(input)).id, first.id);
  const second = await final(
    client,
    (await client.sendMessage(message(randomUUID(), "next"))).id,
  );
  assert.equal(second.contextId, first.contextId);
  assert.equal(f.runs[1].sessionId, "engine-thread");
  assert.equal(f.runs.length, 2);
  const independent = await final(client, (await client.sendMessage(message(randomUUID(), "separate", "other-context"))).id);
  assert.equal(independent.contextId, "other-context");
  assert.equal(f.runs[2].sessionId, undefined);
});

test("queued tasks serialize; cancel never claims running effects were undone; auth is isolated", async (t) => {
  const f = await fixture(t),
    client = await f.client();
  const release = f.hold();
  const one = await client.sendMessage(message(randomUUID(), "one"));
  const two = await client.sendMessage(message(randomUUID(), "two"));
  await assert.rejects(() => client.cancelTask({ id: one.id }));
  assert.equal(
    (await client.cancelTask({ id: two.id })).status.state,
    S.TASK_STATE_CANCELED,
  );
  release();
  await final(client, one.id);
  assert.equal(f.runs.length, 1);
  assert.equal(
    (await fetch(`${f.base}/.well-known/agent-card.json`)).status,
    401,
  );
  const other = await createApiKey({
    kind: "access",
    name: "other",
    models: ["fixture"],
    workspaces: ["work"],
    defaultWorkspace: "work",
  });
  f.config.keys[other.record.id] = other.record;
  assert.equal(
    (
      await fetch(`${f.base}/.well-known/agent-card.json`, {
        headers: { authorization: `Bearer ${other.token}` },
      })
    ).status,
    200,
  );
  const denied = await fetch(`${f.base}/a2a`, { method: "POST", headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json", "a2a-version": "1.0", "a2a-extensions": EXECUTION_EXTENSION }, body: JSON.stringify({ jsonrpc: "2.0", id: "other", method: "GetTask", params: { id: one.id } }) });
  assert.ok((await denied.json()).error);
});

test("unfinished persisted execution becomes unconfirmed and is not replayed", async (t) => {
  const f = await fixture(t),
    client = await f.client();
  const input = message(randomUUID(), "operation");
  const task = await final(client, (await client.sendMessage(input)).id);
  task.status.state = S.TASK_STATE_WORKING;
  f.app.agentService.save(task);
  await f.restart();
  const restored = await final(await f.client(), task.id);
  assert.equal(restored.status.state, S.TASK_STATE_FAILED);
  assert.equal(restored.metadata.outcome, "unconfirmed");
  assert.equal(f.runs.length, 1);
});

test("cancel during preflight never starts the engine and releases capacity", async (t) => {
  const f = await fixture(t),
    client = await f.client(),
    release = f.holdVerification();
  const accepted = await client.sendMessage(message(randomUUID(), "queued"));
  assert.equal(
    (await client.cancelTask({ id: accepted.id })).status.state,
    S.TASK_STATE_CANCELED,
  );
  release();
  await delay(30);
  assert.equal(f.runs.length, 0);
  assert.equal(f.app.activity().standard, 0);
});

test("generic instructions and JSON schema belong to the caller and are part of durable message identity", async (t) => {
  const f = await fixture(t), client = await f.client();
  const input = message(randomUUID(), "Classify this document", "document-application");
  input.message.metadata.execution.instructions = "You are a document classifier.";
  input.message.metadata.execution.responseSchema = {type:"object",properties:{reply:{type:"string"}},required:["reply"],additionalProperties:false};
  const task = await final(client, (await client.sendMessage(input)).id);
  assert.equal(task.status.state, S.TASK_STATE_COMPLETED);
  assert.deepEqual(task.artifacts[0].parts[0].content, {$case:"data",value:{reply:"structured result"}});
  assert.equal(f.runs[0].instructions, "You are a document classifier.");
  assert.ok(!JSON.stringify(task).includes("engine-thread"));
  input.message.metadata.execution.instructions = "Changed purpose";
  await assert.rejects(() => client.sendMessage(input));
  assert.equal(f.runs.length, 1);
});

test("different applications can reuse message and context identifiers without sharing sessions or tasks", async (t) => {
  const f = await fixture(t), client = await f.client();
  const id = randomUUID();
  const first = await final(client, (await client.sendMessage(message(id, "first tenant"))).id);
  const other = await createApiKey({kind:"access",name:"another application",models:["fixture"],workspaces:["work"],defaultWorkspace:"work"});
  f.config.keys[other.record.id] = other.record;
  const secondClient = await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:(url, init) => fetch(url, {...init,headers:{...Object.fromEntries(new Headers(init?.headers)), authorization:`Bearer ${other.token}`,"a2a-version":"1.0","a2a-extensions":EXECUTION_EXTENSION}})})]}).createFromAgentCard(AgentCard.fromJSON(await (await f.authFetch(`${f.base}/.well-known/agent-card.json`)).json()));
  const second = await final(secondClient, (await secondClient.sendMessage(message(id, "second tenant"))).id);
  assert.notEqual(first.id, second.id);
  assert.equal(f.runs[1].sessionId, undefined);
  await assert.rejects(() => secondClient.getTask(GetTaskRequest.fromJSON({id:first.id})));
});
