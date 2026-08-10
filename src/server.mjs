import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  authorize,
  ConcurrencyGate,
  HttpError,
  requireGrant,
  strictObject,
  validateConfig,
} from "./core.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function createAllApiServer({ config, registry, dataDirectory }) {
  validateConfig(config);
  const responses = new ResponseStore(path.join(dataDirectory, "responses.json"), {
    retentionDays: config.server.responseRetentionDays,
  });
  await responses.load();
  const files = new FileStore(path.join(dataDirectory, "files"));
  await files.load();
  const gate = new ConcurrencyGate(config.server.maxConcurrent);
  const controllers = new Set();
  const nativeSessions = new Set();
  const nativeSessionsByKey = new Map();
  const server = createServer(async (request, response) => {
    try {
      await route({ request, response, config, registry, responses, files, gate, controllers });
    } catch (error) {
      if (process.env.ALL_API_DEBUG === "1") console.error(error);
      sendError(response, error, Boolean(request.headers["anthropic-version"]));
    }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: config.server.maxNativeFrameBytes,
    handleProtocols(protocols) {
      return protocols.has("allapi.native") ? "allapi.native" : false;
    },
  });
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade({
      request, socket, head, config, registry, webSockets, nativeSessions, nativeSessionsByKey,
    }).catch((error) => {
      rejectUpgrade(socket, error);
    });
  });

  return {
    server,
    registry,
    responses,
    files,
    activity() {
      return { standard: gate.active, native: nativeSessions.size };
    },
    async revokeKey(keyId) {
      await Promise.allSettled(
        [...(nativeSessionsByKey.get(keyId) ?? [])].map((close) => close(1008, "API key revoked")),
      );
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.server.port, config.server.host, resolve);
      });
      return server.address();
    },
    async close() {
      await Promise.allSettled([...nativeSessions].map((close) => close()));
      for (const client of webSockets.clients) client.terminate();
      for (const controller of controllers) controller.abort(new Error("All API is shutting down"));
      await new Promise((resolve) => webSockets.close(resolve));
      server.close();
      for (const socket of sockets) socket.destroy();
      await registry.close();
      await Promise.all([responses.close(), files.flush()]);
    },
  };
}

async function route(context) {
  const { request, response, config } = context;
  const url = new URL(request.url, "http://all-api.local");
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }
  const token = bearerOrApiKey(request);
  const grant = await authorize(config, token);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(response, 200, request.headers["anthropic-version"]
      ? anthropicModels(context, grant)
      : openAiModels(context, grant));
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    requireModelVisible(config, grant, id);
    if (!config.models[id]) throw new HttpError(404, `Model "${id}" not found`, "not_found");
    return sendJson(response, 200, request.headers["anthropic-version"]
      ? anthropicModel(context, id)
      : openAiModel(context, id));
  }
  if (request.method === "GET" && url.pathname === "/allapi/v1/catalog") {
    return sendJson(response, 200, await catalog(context, grant));
  }
  requireAccessKey(grant);
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    return chatCompletions(context, grant);
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    return createResponse(context, grant);
  }
  if (url.pathname.startsWith("/v1/responses/")) {
    return responseLifecycle(context, grant, url);
  }
  if (request.method === "POST" && url.pathname === "/v1/messages") {
    requireAnthropicVersion(request);
    return messages(context, grant);
  }
  if (url.pathname === "/v1/files" || url.pathname.startsWith("/v1/files/")) {
    return filesRoute(context, grant, url);
  }
  throw new HttpError(404, `Unknown endpoint: ${request.method} ${url.pathname}`, "not_found");
}

async function chatCompletions(context, grant) {
  const { request, response } = context;
  const body = strictObject(await readJson(request), CHAT_FIELDS, ["model", "messages"]);
  ensureArray(body.messages, "messages");
  optionalBoolean(body.stream, "stream");
  optionalBoolean(body.parallel_tool_calls, "parallel_tool_calls");
  optionalNumber(body.temperature, "temperature");
  if (body.stream_options !== undefined) {
    strictObject(body.stream_options, ["include_usage"]);
    optionalBoolean(body.stream_options.include_usage, "stream_options.include_usage");
  }
  rejectUnsupported(body, ["metadata", "user"]);
  const converted = chatInput(body.messages);
  const tools = validateOpenAiTools(body.tools);
  const run = await prepareRun(context, grant, body.model, request.headers["x-allapi-workspace"], {
    protocol: "chat_completions",
    ...converted,
    tools,
    toolContext: {
      ...(body.tools !== undefined && { tools }),
      ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
      ...(body.parallel_tool_calls !== undefined
        && { parallel_tool_calls: body.parallel_tool_calls }),
    },
  });
  if (body.stream) {
    startSse(response);
    let roleSent = false;
    let terminal = false;
    for await (const event of run.events) {
      if (event.type === "text.delta") {
        sendSse(response, {
          id: run.id,
          object: "chat.completion.chunk",
          created: run.created,
          model: body.model,
          choices: [{
            index: 0,
            delta: roleSent ? { content: event.delta } : { role: "assistant", content: event.delta },
            finish_reason: null,
          }],
          ...(body.stream_options?.include_usage && { usage: null }),
        });
        roleSent = true;
      } else if (event.type === "completed" || event.type === "interrupted") {
        if (body.stream_options?.include_usage) {
          requireUsage(event.usage, "Chat Completions stream_options.include_usage");
        }
        terminal = true;
        sendSse(response, {
          id: run.id,
          object: "chat.completion.chunk",
          created: run.created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          ...(body.stream_options?.include_usage && { usage: null }),
        });
        if (body.stream_options?.include_usage && event.usage) {
          sendSse(response, {
            id: run.id,
            object: "chat.completion.chunk",
            created: run.created,
            model: body.model,
            choices: [],
            usage: openAiUsage(event.usage),
          });
        }
      }
    }
    if (!terminal) throw agentMissingTerminalError();
    writeIfOpen(response, "data: [DONE]\n\n");
    return response.end();
  }

  const result = await collect(run.events);
  return sendJson(response, 200, {
    id: run.id,
    object: "chat.completion",
    created: run.created,
    model: body.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: result.text || null,
      },
      finish_reason: "stop",
    }],
    ...(result.usage && { usage: openAiUsage(result.usage) }),
  });
}

async function createResponse(context, grant) {
  const { request, response, responses } = context;
  const body = strictObject(await readJson(request), RESPONSE_FIELDS, ["model", "input"]);
  optionalBoolean(body.stream, "stream");
  optionalBoolean(body.store, "store");
  optionalBoolean(body.parallel_tool_calls, "parallel_tool_calls");
  optionalNumber(body.temperature, "temperature");
  if (body.metadata !== undefined && (
    body.metadata === null
    || typeof body.metadata !== "object"
    || Array.isArray(body.metadata)
  )) {
    throw new HttpError(400, "'metadata' must be an object", "invalid_request_error", "metadata");
  }
  const previous = body.previous_response_id
    ? responses.require(body.previous_response_id, grant.keyId)
    : undefined;
  if (previous && (previous.status !== "completed" || !previous.agentSessionId)) {
    throw new HttpError(400, "previous_response_id is not a completed resumable response");
  }
  if (previous && (previous.model !== body.model || previous.workspace !== workspaceId(request, grant))) {
    throw new HttpError(400, "previous_response_id belongs to a different model or workspace");
  }
  const tools = validateResponseTools(body.tools);
  const run = await prepareRun(context, grant, body.model, request.headers["x-allapi-workspace"], {
    protocol: "responses",
    input: responseInput(body.input),
    instructions: body.instructions,
    tools,
    toolContext: {
      ...(body.tools !== undefined && { tools }),
      ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
      ...(body.parallel_tool_calls !== undefined
        && { parallel_tool_calls: body.parallel_tool_calls }),
    },
    sessionId: previous?.agentSessionId,
  });
  const record = responses.create({
    id: run.id.replace("chatcmpl_", "resp_"),
    keyId: grant.keyId,
    model: body.model,
    workspace: run.workspace,
    metadata: body.metadata ?? {},
    parallelToolCalls: body.parallel_tool_calls ?? true,
    persist: body.store !== false,
    controller: run.controller,
  });
  if (body.stream) {
    startSse(response);
    try {
      let sequence = 0;
      sendSse(response, {
        type: "response.created",
        response: responseEnvelope(record, "in_progress"),
        sequence_number: sequence++,
      }, "response.created");
      sendSse(response, {
        type: "response.in_progress",
        response: responseEnvelope(record, "in_progress"),
        sequence_number: sequence++,
      }, "response.in_progress");
      let text = "";
      let textStarted = false;
      let terminal = false;
      for await (const event of run.events) {
        if (event.type === "text.delta") {
          if (!textStarted) {
            textStarted = true;
            sendSse(response, {
              type: "response.output_item.added",
              output_index: 0,
              item: responseMessage(record, "", "in_progress"),
              sequence_number: sequence++,
            }, "response.output_item.added");
            sendSse(response, {
              type: "response.content_part.added",
              item_id: `${record.id}_message`,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
              sequence_number: sequence++,
            }, "response.content_part.added");
          }
          text += event.delta;
          sendSse(response, {
            type: "response.output_text.delta",
            item_id: `${record.id}_message`,
            output_index: 0,
            content_index: 0,
            delta: event.delta,
            sequence_number: sequence++,
          }, "response.output_text.delta");
        } else if (event.type === "completed" || event.type === "interrupted") {
          terminal = true;
          if (textStarted) {
            sendSse(response, {
              type: "response.output_text.done",
              item_id: `${record.id}_message`,
              output_index: 0,
              content_index: 0,
              text,
              sequence_number: sequence++,
            }, "response.output_text.done");
            sendSse(response, {
              type: "response.content_part.done",
              item_id: `${record.id}_message`,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text, annotations: [] },
              sequence_number: sequence++,
            }, "response.content_part.done");
            sendSse(response, {
              type: "response.output_item.done",
              output_index: 0,
              item: responseMessage(record, text, "completed"),
              sequence_number: sequence++,
            }, "response.output_item.done");
          }
          const output = responseOutput(record, text);
          const finish = event.type === "completed"
            ? responses.complete.bind(responses)
            : responses.interrupt.bind(responses);
          const didComplete = finish(record.id, {
            agentSessionId: event.sessionId,
            usage: event.usage,
            output,
          });
          if (!didComplete) break;
          const completed = responseEnvelope(record, record.status);
          const responseEvent = record.status === "completed"
            ? "response.completed"
            : "response.incomplete";
          sendSse(response, {
            type: responseEvent,
            response: completed,
            sequence_number: sequence++,
          }, responseEvent);
          if (!record.persist) responses.delete(record.id);
        }
      }
      if (!terminal) throw agentMissingTerminalError();
      return response.end();
    } catch (error) {
      responses.fail(record.id, error);
      if (!record.persist) responses.delete(record.id);
      throw error;
    }
  }

  try {
    const result = await collect(run.events);
    const output = responseOutput(record, result.text);
    const finish = result.status === "interrupted"
      ? responses.interrupt.bind(responses)
      : responses.complete.bind(responses);
    finish(record.id, {
      agentSessionId: result.sessionId,
      usage: result.usage,
      output,
    });
    const resultBody = responseEnvelope(record, record.status);
    if (!record.persist) responses.delete(record.id);
    return sendJson(response, 200, resultBody);
  } catch (error) {
    responses.fail(record.id, error);
    if (!record.persist) responses.delete(record.id);
    throw error;
  }
}

async function responseLifecycle(context, grant, url) {
  const { request, response, responses } = context;
  const [, , , id, action] = url.pathname.split("/");
  const record = responses.require(id, grant.keyId);
  if (request.method === "POST" && action === "cancel") {
    if (!responses.cancel(id)) {
      throw new HttpError(400, `Response "${id}" is already terminal`, "invalid_request_error");
    }
    return sendJson(response, 200, responseEnvelope(record, record.status));
  }
  if (request.method === "DELETE" && !action) {
    responses.delete(id);
    return sendJson(response, 200, { id, object: "response.deleted", deleted: true });
  }
  if (request.method === "GET" && !action) {
    return sendJson(response, 200, responseEnvelope(record, record.status));
  }
  throw new HttpError(404, "Response operation not found", "not_found");
}

async function messages(context, grant) {
  const { request, response } = context;
  const body = strictObject(await readJson(request), MESSAGE_FIELDS, ["model", "max_tokens", "messages"]);
  ensureArray(body.messages, "messages");
  optionalBoolean(body.stream, "stream");
  optionalNumber(body.temperature, "temperature");
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    throw new HttpError(400, "'max_tokens' must be a positive integer", "invalid_request_error", "max_tokens");
  }
  rejectUnsupported(body, ["metadata", "stop_sequences"]);
  const converted = anthropicInput(body.messages, body.system);
  const tools = validateAnthropicTools(body.tools);
  const run = await prepareRun(context, grant, body.model, request.headers["x-allapi-workspace"], {
    protocol: "messages",
    ...converted,
    tools,
    toolContext: {
      ...(body.tools !== undefined && { tools }),
      ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
    },
  });
  const messageId = run.id.replace("chatcmpl_", "msg_");
  if (body.stream) {
    const result = await collect(run.events);
    requireUsage(result.usage, "Anthropic Messages");
    startSse(response);
    sendSse(response, {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: body.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: result.usage.input_tokens, output_tokens: 0 },
      },
    }, "message_start");
    if (result.text) {
      sendSse(response, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }, "content_block_start");
      sendSse(response, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: result.text },
      }, "content_block_delta");
      sendSse(response, { type: "content_block_stop", index: 0 }, "content_block_stop");
    }
    sendSse(response, {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: result.usage.output_tokens },
    }, "message_delta");
    sendSse(response, { type: "message_stop" }, "message_stop");
    return response.end();
  }
  const result = await collect(run.events);
  requireUsage(result.usage, "Anthropic Messages");
  return sendJson(response, 200, {
    id: messageId,
    type: "message",
    role: "assistant",
    content: result.text ? [{ type: "text", text: result.text }] : [],
    model: body.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: result.usage,
  });
}

async function prepareRun(context, grant, modelId, selectedWorkspace, options) {
  const { config, registry, gate, files, controllers } = context;
  requireGrant(grant, "model", modelId);
  const profile = config.models[modelId];
  if (!profile) throw new HttpError(404, `Model "${modelId}" does not exist`, "model_not_found");
  const workspace = selectedWorkspace || defaultWorkspace(grant);
  requireGrant(grant, "workspace", workspace);
  const workspaceConfig = config.workspaces[workspace];
  if (!workspaceConfig) throw new HttpError(404, `Workspace "${workspace}" does not exist`);
  const adapter = registry.get(profile.agent);
  const compatibility = await adapter.verifyStandard?.() ?? {
    status: "unverified",
    reason: "Agent adapter has no standard protocol certification",
  };
  const protocolCompatibility = compatibility.protocols?.[options.protocol] ?? {
    status: "unverified",
    reason: `Agent adapter has no ${options.protocol} certification`,
  };
  if (protocolCompatibility.status !== "verified") {
    throw new HttpError(
      409,
      protocolCompatibility.reason
        ?? compatibility.reason
        ?? `Selected Agent is not verified for ${options.protocol}`,
      "agent_protocol_unverified",
    );
  }
  const textualInput = standardInput(options.input, options.toolContext);
  const input = await Promise.all(textualInput.map((block) =>
    resolveInputBlock(block, files, grant.keyId)));
  assertCapabilities(adapter.capabilities, input);
  const release = gate.acquire();
  const controller = new AbortController();
  controllers.add(controller);
  const events = releaseWhenDone(standardAgentEvents(adapter.run({
    model: modelId,
    profile,
    workspace: { id: workspace, ...workspaceConfig },
    input,
    instructions: options.instructions,
    tools: [],
    sessionId: options.sessionId,
    signal: controller.signal,
  }), options.protocol === "responses"
    && config.server.responsesIncludeProcessEvents !== false), () => {
    controllers.delete(controller);
    release();
  });
  return {
    id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    workspace,
    controller,
    events,
  };
}

async function filesRoute(context, grant, url) {
  const { request, response, files } = context;
  const anthropic = Boolean(request.headers["anthropic-version"]);
  if (anthropic && !String(request.headers["anthropic-beta"] ?? "").split(",").map((v) => v.trim())
    .includes("files-api-2025-04-14")) {
    throw new HttpError(400, "anthropic-beta: files-api-2025-04-14 is required");
  }
  if (request.method === "POST" && url.pathname === "/v1/files") {
    const body = await readBuffer(request, MAX_FILE_BYTES);
    const form = await new Request("http://all-api.local/v1/files", {
      method: "POST",
      headers: { "content-type": request.headers["content-type"] ?? "" },
      body,
    }).formData();
    const upload = form.get("file");
    if (!upload || typeof upload.arrayBuffer !== "function") {
      throw new HttpError(400, "multipart field 'file' is required");
    }
    const purpose = form.get("purpose");
    if (!anthropic && !purpose) throw new HttpError(400, "multipart field 'purpose' is required");
    const result = await files.create({
      owner: grant.keyId,
      filename: upload.name,
      purpose: anthropic ? "anthropic" : String(purpose),
      mediaType: upload.type || "application/octet-stream",
      bytes: Buffer.from(await upload.arrayBuffer()),
    });
    return sendJson(response, 200, anthropic ? anthropicFile(result) : files.public(result));
  }
  if (request.method === "GET" && url.pathname === "/v1/files") {
    const records = files.records(grant.keyId);
    const items = records.map((file) => files.public(file));
    return sendJson(response, 200, anthropic ? {
      data: records.map(anthropicFile),
      first_id: items[0]?.id ?? null,
      last_id: items.at(-1)?.id ?? null,
      has_more: false,
    } : { object: "list", data: items, has_more: false });
  }
  const parts = url.pathname.split("/");
  const id = parts[3];
  if (!id) throw new HttpError(404, "File not found", "not_found");
  if (request.method === "GET" && parts[4] === "content") {
    const file = files.require(id, grant.keyId);
    if (anthropic) throw new HttpError(400, "Uploaded Anthropic files are not downloadable");
    response.writeHead(200, {
      "content-type": file.mediaType,
      "content-length": file.bytes,
      "content-disposition": `attachment; filename="${safeFilename(file.filename)}"`,
    });
    return response.end(await readFile(file.path));
  }
  if (request.method === "GET" && !parts[4]) {
    const file = files.public(files.require(id, grant.keyId));
    return sendJson(response, 200, anthropic ? anthropicFile(file) : file);
  }
  if (request.method === "DELETE" && !parts[4]) {
    await files.delete(id, grant.keyId);
    return sendJson(response, 200, anthropic
      ? { id, type: "file_deleted" }
      : { id, object: "file", deleted: true });
  }
  throw new HttpError(404, "File operation not found", "not_found");
}

async function handleUpgrade({
  request, socket, head, config, registry, webSockets, nativeSessions, nativeSessionsByKey,
}) {
  const url = new URL(request.url, "http://all-api.local");
  if (url.pathname !== "/v1/native/sessions") {
    throw new HttpError(404, "Native endpoint not found", "not_found");
  }
  const grant = await authorize(config, bearerOrApiKey(request), "native");
  const modelId = url.searchParams.get("model");
  if (!modelId) throw new HttpError(400, "model query parameter is required");
  if ([...url.searchParams.keys()].some((name) => name !== "model")) {
    throw new HttpError(400, "Native accepts only the model query parameter");
  }
  const profile = config.models[modelId];
  if (!profile) throw new HttpError(404, `Model "${modelId}" does not exist`, "model_not_found");
  const workspaceId = profile.workspace;
  const workspace = workspaceId ? config.workspaces[workspaceId] : undefined;
  const adapter = registry.get(profile.agent);
  if (!adapter.capabilities.native || !adapter.openNative) {
    throw new HttpError(400, `Model "${modelId}" has no native transport`);
  }
  if (nativeSessions.size >= config.server.maxNativeConnections) {
    throw new HttpError(429, "Native connection limit reached", "server_busy");
  }
  webSockets.handleUpgrade(request, socket, head, async (webSocket) => {
    let native;
    let closed = false;
    let incoming = Promise.resolve();
    const pendingFrames = [];
    let pendingBytes = 0;
    const closeNative = async (code, reason) => {
      if (closed) return;
      closed = true;
      const current = native;
      native = undefined;
      nativeSessions.delete(closeNative);
      pendingFrames.length = 0;
      pendingBytes = 0;
      const keyed = nativeSessionsByKey.get(grant.keyId);
      keyed?.delete(closeNative);
      if (keyed?.size === 0) nativeSessionsByKey.delete(grant.keyId);
      if (code && webSocket.readyState === webSocket.OPEN) webSocket.close(code, reason);
      await current?.close();
    };
    webSocket.once("close", () => {
      closeNative().catch(() => {});
    });
    webSocket.once("error", (error) => {
      closeNative(1009, String(error?.message ?? error).slice(0, 120)).catch(() => {});
    });
    const drainFrames = () => {
      if (!native || closed) return;
      const current = native;
      while (pendingFrames.length) {
        const [data, isBinary] = pendingFrames.shift();
        incoming = incoming
          .then(() => current.receive(data, isBinary))
          .finally(() => {
            pendingBytes = Math.max(0, pendingBytes - data.byteLength);
          })
          .catch((error) => {
            closeNative(1011, String(error?.message ?? error).slice(0, 120)).catch(() => {});
          });
      }
    };
    webSocket.on("message", (data, isBinary) => {
      if (data.byteLength > config.server.maxNativeFrameBytes) {
        closeNative(1009, "Native frame limit exceeded").catch(() => {});
        return;
      }
      if (pendingBytes + data.byteLength > config.server.maxNativeBufferedBytes) {
        closeNative(1009, "Native input buffer limit exceeded").catch(() => {});
        return;
      }
      pendingBytes += data.byteLength;
      pendingFrames.push([Buffer.from(data), isBinary]);
      drainFrames();
    });
    try {
      nativeSessions.add(closeNative);
      const keyed = nativeSessionsByKey.get(grant.keyId) ?? new Set();
      keyed.add(closeNative);
      nativeSessionsByKey.set(grant.keyId, keyed);
      native = await adapter.openNative({
        profile,
        workspace: workspace ? { id: workspaceId, ...workspace } : undefined,
        send(frame, isBinary = Buffer.isBuffer(frame)) {
          if (webSocket.readyState !== webSocket.OPEN) return;
          const bytes = Buffer.isBuffer(frame) ? frame.byteLength : Buffer.byteLength(String(frame));
          if (bytes > config.server.maxNativeFrameBytes) {
            closeNative(1009, "Native frame limit exceeded").catch(() => {});
            return;
          }
          if (webSocket.bufferedAmount + bytes > config.server.maxNativeBufferedBytes) {
            closeNative(1009, "Native output buffer limit exceeded").catch(() => {});
            return;
          }
          webSocket.send(frame, { binary: isBinary });
        },
        fail(error) {
          const normal = error?.exitCode === 0 && !error.signal;
          closeNative(
            normal ? 1000 : 1011,
            normal ? "Agent transport ended" : String(error?.message ?? error).slice(0, 120),
          ).catch(() => {});
        },
      });
      if (closed) {
        const current = native;
        native = undefined;
        await current.close();
        return;
      }
      drainFrames();
    } catch (error) {
      await closeNative();
      webSocket.close(1011, error.message.slice(0, 120));
    }
  });
}

export class ResponseStore {
  #records = new Map();
  #saving = Promise.resolve();
  #retentionMs;
  #now;
  #expiryTimer;

  constructor(filename, { retentionDays = 30, now = Date.now } = {}) {
    this.filename = filename;
    this.#retentionMs = retentionDays * 86_400_000;
    this.#now = now;
    this.#expiryTimer = setInterval(
      () => this.#pruneExpired(),
      Math.max(10, Math.min(this.#retentionMs, 3_600_000)),
    );
    this.#expiryTimer.unref();
  }

  async load() {
    if (!this.filename) return;
    try {
      const records = JSON.parse(await readFile(this.filename, "utf8"));
      for (const record of records) {
        if (this.#expired(record)) continue;
        if (record.status === "in_progress") {
          record.status = "incomplete";
          record.incompleteDetails = { reason: "server_restarted" };
        }
        this.#records.set(record.id, record);
      }
      await this.#save();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  create(record) {
    const now = this.#now();
    const value = {
      ...record,
      object: "response",
      status: "in_progress",
      createdAt: Math.floor(now / 1000),
      expiresAt: Math.floor((now + this.#retentionMs) / 1000),
    };
    this.#records.set(value.id, value);
    this.#save().catch(() => {});
    return value;
  }

  complete(id, metadata) {
    const record = this.#records.get(id);
    if (!record || record.status !== "in_progress") return false;
    record.status = "completed";
    record.agentSessionId = metadata.agentSessionId;
    record.usage = metadata.usage;
    record.output = metadata.output ?? [];
    delete record.controller;
    this.#save().catch(() => {});
    return true;
  }

  interrupt(id, metadata) {
    const record = this.#records.get(id);
    if (!record || record.status !== "in_progress") return false;
    record.status = "incomplete";
    record.incompleteDetails = { reason: "agent_interrupted" };
    record.agentSessionId = metadata.agentSessionId;
    record.usage = metadata.usage;
    record.output = metadata.output ?? [];
    delete record.controller;
    this.#save().catch(() => {});
    return true;
  }

  fail(id, error) {
    const record = this.#records.get(id);
    if (!record || record.status !== "in_progress") return false;
    record.status = "failed";
    record.error = {
      code: error.code ?? "agent_error",
      type: "server_error",
      message: "Agent execution failed",
    };
    delete record.controller;
    this.#save().catch(() => {});
    return true;
  }

  cancel(id) {
    const record = this.#records.get(id);
    if (!record || record.status !== "in_progress") return false;
    record?.controller?.abort(new Error("Cancelled by client"));
    record.status = "cancelled";
    delete record.controller;
    this.#save().catch(() => {});
    return true;
  }

  require(id, keyId) {
    const record = this.#records.get(id);
    if (record && this.#expired(record)) {
      this.#records.delete(id);
      this.#save().catch(() => {});
    }
    if (!record || record.persist === false || this.#expired(record) || record.keyId !== keyId) {
      throw new HttpError(404, `Response "${id}" not found`, "not_found");
    }
    return record;
  }

  delete(id) {
    this.#records.delete(id);
    this.#save().catch(() => {});
  }

  snapshot() {
    return [...this.#records.values()].map(({ controller, keyId, persist, ...record }) => ({ ...record }));
  }

  flush() {
    return this.#saving;
  }

  async close() {
    clearInterval(this.#expiryTimer);
    await this.#saving;
  }

  async #save() {
    if (!this.filename) return;
    this.#saving = this.#saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const records = [...this.#records.values()]
        .filter((record) => record.persist !== false)
        .map(({ controller, persist, ...record }) => record);
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
      await rename(temporary, this.filename);
    });
    return this.#saving;
  }

  #expired(record) {
    return Number.isFinite(record.expiresAt)
      && record.expiresAt <= Math.floor(this.#now() / 1000);
  }

  #pruneExpired() {
    let changed = false;
    for (const [id, record] of this.#records) {
      if (!this.#expired(record)) continue;
      record.controller?.abort(new Error("Response retention expired"));
      this.#records.delete(id);
      changed = true;
    }
    if (changed) this.#save().catch(() => {});
  }
}

class FileStore {
  #files = new Map();
  #saving = Promise.resolve();

  constructor(directory) {
    this.directory = directory;
    this.indexPath = path.join(directory, "index.json");
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      for (const item of JSON.parse(await readFile(this.indexPath, "utf8"))) this.#files.set(item.id, item);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async create({ owner, filename, purpose, mediaType, bytes }) {
    const id = `file_${crypto.randomUUID().replaceAll("-", "")}`;
    const filePath = path.join(this.directory, id);
    await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    const record = {
      id,
      object: "file",
      bytes: bytes.length,
      created_at: Math.floor(Date.now() / 1000),
      filename,
      purpose,
      mediaType,
      owner,
      path: filePath,
    };
    this.#files.set(id, record);
    await this.#save();
    return record;
  }

  records(owner) {
    return [...this.#files.values()].filter((file) => file.owner === owner);
  }

  require(id, owner) {
    const file = this.#files.get(id);
    if (!file || file.owner !== owner) throw new HttpError(404, `File "${id}" not found`, "not_found");
    return file;
  }

  public({ owner, path: filePath, mediaType, ...record }) {
    return record;
  }

  async delete(id, owner) {
    const file = this.require(id, owner);
    await rm(file.path, { force: true });
    this.#files.delete(id);
    await this.#save();
  }

  flush() {
    return this.#saving;
  }

  async #save() {
    this.#saving = this.#saving.catch(() => {}).then(() =>
      writeFile(this.indexPath, JSON.stringify([...this.#files.values()]), { mode: 0o600 }));
    return this.#saving;
  }
}

const CHAT_FIELDS = [
  "model", "messages", "stream", "stream_options", "tools", "tool_choice",
  "parallel_tool_calls", "metadata", "user", "temperature",
];
const RESPONSE_FIELDS = [
  "model", "input", "previous_response_id", "stream", "tools", "tool_choice",
  "parallel_tool_calls", "metadata", "store", "instructions", "temperature",
];
const MESSAGE_FIELDS = [
  "model", "max_tokens", "messages", "system", "stream", "tools", "tool_choice",
  "metadata", "stop_sequences", "temperature",
];

function openAiModels({ config, registry }, grant) {
  return {
    object: "list",
    data: visibleModels(config, grant).map((id) => openAiModel({ config }, id)),
  };
}

function openAiModel({ config }, id) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: `all-api:${config.models[id].agent}`,
  };
}

function anthropicModels(context, grant) {
  const data = visibleModels(context.config, grant).map((id) => anthropicModel(context, id));
  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: false,
  };
}

function anthropicModel({ config, registry }, id) {
  const capabilities = registry.get(config.models[id].agent).capabilities;
  return {
    id,
    type: "model",
    display_name: id,
    created_at: "1970-01-01T00:00:00.000Z",
    max_input_tokens: 0,
    max_tokens: 0,
    capabilities: {
      image_input: { supported: capabilities.input.includes("image") },
      pdf_input: { supported: capabilities.input.includes("file") },
      code_execution: { supported: capabilities.tools.includes("agent") },
      structured_outputs: { supported: false },
    },
  };
}

async function catalog({ config, registry }, grant) {
  const models = await Promise.all(visibleModels(config, grant).map(async (id) => {
    const profile = config.models[id];
    const adapter = registry.get(profile.agent);
    const [description, compatibility] = await Promise.all([
      adapter.describe?.() ?? {},
      adapter.verifyStandard?.() ?? {
        status: "unverified",
        reason: "Agent adapter has no standard protocol certification",
      },
    ]);
    return {
      id,
      agent: profile.agent,
      agent_version: description.version ?? null,
      source: profile.source,
      workspace: profile.workspace ?? null,
      capabilities: adapter.capabilities,
      standard_compatibility: compatibility,
      protocols: {
        chat_completions: {
          supported: compatibility.protocols?.chat_completions?.status === "verified",
          parameters: CHAT_FIELDS,
          client_tools: false,
          tools_as_text: true,
          tool_choice: "text_context_only",
          parallel_tool_calls_false: true,
          unsupported_parameters: ["metadata", "user"],
          interactive_approvals: false,
          agent_process_events: "omitted",
        },
        responses: {
          supported: compatibility.protocols?.responses?.status === "verified",
          parameters: RESPONSE_FIELDS,
          client_tools: false,
          tools_as_text: true,
          tool_choice: "text_context_only",
          parallel_tool_calls_false: true,
          interactive_approvals: false,
          agent_process_events: config.server.responsesIncludeProcessEvents === false
            ? "omitted"
            : "text",
        },
        messages: {
          supported: compatibility.protocols?.messages?.status === "verified",
          parameters: MESSAGE_FIELDS,
          client_tools: false,
          tools_as_text: true,
          tool_choice: "text_context_only",
          max_tokens_enforced: false,
          unsupported_parameters: ["metadata", "stop_sequences"],
          interactive_approvals: false,
          agent_process_events: "omitted",
        },
        native: {
          supported: Boolean(adapter.capabilities.native),
          lossless_agent_events: Boolean(adapter.capabilities.native),
          interactive_approvals: Boolean(adapter.capabilities.approvals),
          transport: adapter.native?.transport ?? null,
          protocol: adapter.native?.protocol ?? null,
          protocol_version: adapter.native?.protocolVersion ?? null,
          resumable: Boolean(adapter.native?.resumable),
          client_tools: Boolean(adapter.native?.clientTools),
          startup_configuration: "model_profile",
          frame_configuration: "agent_protocol_only",
          workspace_from_frames: Boolean(adapter.native?.workspaceFromFrames),
          agent_process_events: "lossless",
        },
      },
      unsupported_behavior: "error",
      usage: adapter.capabilities.usage ? "official_agent_data_only" : "unavailable",
    };
  }));
  return {
    object: "allapi.catalog",
    limits: {
      json_body_bytes: MAX_JSON_BYTES,
      file_upload_bytes: MAX_FILE_BYTES,
      standard_concurrency: config.server.maxConcurrent,
      native_connections: config.server.maxNativeConnections,
      native_frame_bytes: config.server.maxNativeFrameBytes,
      native_buffered_bytes: config.server.maxNativeBufferedBytes,
    },
    models,
    workspaces: visibleWorkspaces(config, grant).map((id) => ({
      id,
      label: config.workspaces[id].label ?? id,
    })),
    default_workspace: grant.kind === "access" ? grant.defaultWorkspace : null,
  };
}

function responseEnvelope(record, status, text, usage) {
  const output = text === undefined ? record.output ?? [] : responseOutput(record, text);
  const finalUsage = usage ?? record.usage;
  return {
    id: record.id,
    object: "response",
    created_at: record.createdAt,
    status,
    model: record.model,
    metadata: record.metadata ?? {},
    output,
    parallel_tool_calls: record.parallelToolCalls ?? true,
    error: status === "failed" ? record.error : null,
    incomplete_details: status === "incomplete" ? record.incompleteDetails : null,
    ...(finalUsage && { usage: responseUsage(finalUsage) }),
  };
}

function responseOutput(record, text) {
  return text ? [responseMessage(record, text, "completed")] : [];
}

function responseMessage(record, text, status) {
  return {
    id: `${record.id}_message`,
    type: "message",
    status,
    role: "assistant",
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  };
}

function chatInput(messages) {
  const input = [];
  const instructions = [];
  messages.forEach((message, index) => {
    strictObject(message, ["role", "content", "name", "tool_call_id", "tool_calls"], ["role"]);
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) {
      throw new HttpError(400, `Unsupported message role at messages[${index}]`);
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new HttpError(400, `messages[${index}].tool_call_id is required`);
      input.push({
        type: "tool_result",
        id: message.tool_call_id,
        content: message.content,
      });
      return;
    }
    const content = message.content == null
      ? []
      : openAiContent(message.content, `messages[${index}].content`);
    if (["system", "developer"].includes(message.role)) {
      instructions.push(...content.filter((block) => block.type === "text").map((block) => block.text));
      if (content.some((block) => block.type !== "text")) {
        throw new HttpError(400, `${message.role} messages only support text content`);
      }
      return;
    }
    const calls = (message.tool_calls ?? []).map((call) => ({
      type: "tool_call",
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    }));
    input.push({ type: "text", text: `${message.role.toUpperCase()}:\n` }, ...content, ...calls);
  });
  return { input, instructions: instructions.join("\n\n") || undefined };
}

function responseInput(input) {
  const blocks = [];
  if (typeof input === "string") return [...blocks, { type: "text", text: input }];
  ensureArray(input, "input");
  for (const [index, item] of input.entries()) {
    if (item.type === "message") {
      blocks.push({ type: "text", text: `${item.role.toUpperCase()}:\n` });
      blocks.push(...openAiContent(item.content, `input[${index}].content`));
    } else if (item.type === "input_text") {
      blocks.push({ type: "text", text: item.text });
    } else if (item.type === "input_image") {
      blocks.push(imageBlock(item.image_url ?? item.file_id, `input[${index}]`));
    } else if (item.type === "input_file") {
      blocks.push({ type: "file", path: item.file_id ?? item.file_url });
    } else if (item.type === "function_call") {
      blocks.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    } else if (item.type === "function_call_output") {
      blocks.push({ type: "tool_result", id: item.call_id, content: item.output });
    } else {
      throw new HttpError(400, `Unsupported input item type: '${item.type}'`);
    }
  }
  return blocks;
}

function anthropicInput(messages, system) {
  const blocks = [];
  let instructions;
  if (system) {
    instructions = typeof system === "string"
      ? system
      : system.map((block) => block.text ?? "").join("\n");
  }
  for (const [index, message] of messages.entries()) {
    strictObject(message, ["role", "content"], ["role", "content"]);
    if (!["user", "assistant"].includes(message.role)) {
      throw new HttpError(400, `Unsupported role at messages[${index}]`);
    }
    blocks.push({ type: "text", text: `${message.role.toUpperCase()}:\n` });
    if (typeof message.content === "string") {
      blocks.push({ type: "text", text: message.content });
      continue;
    }
    ensureArray(message.content, `messages[${index}].content`);
    for (const block of message.content) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        if (block.source?.type === "url") blocks.push(imageBlock(block.source.url, "image"));
        else if (block.source?.type === "base64") {
          blocks.push(imageBlock(`data:${block.source.media_type};base64,${block.source.data}`, "image"));
        } else throw new HttpError(400, "Unsupported Anthropic image source");
      } else if (block.type === "document") {
        blocks.push({ type: "file", path: block.source?.file_id ?? block.source?.url });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      } else if (block.type === "tool_result") {
        blocks.push({ type: "tool_result", id: block.tool_use_id, content: block.content });
      } else {
        throw new HttpError(400, `Unsupported Anthropic content block: '${block.type}'`);
      }
    }
  }
  return { input: blocks, instructions };
}

function openAiContent(content, field) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  ensureArray(content, field);
  return content.map((block) => {
    if (block.type === "text" || block.type === "input_text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image_url") {
      return imageBlock(typeof block.image_url === "string" ? block.image_url : block.image_url?.url, field);
    }
    if (block.type === "input_image") return imageBlock(block.image_url ?? block.file_id, field);
    if (block.type === "file" || block.type === "input_file") {
      return { type: "file", path: block.file?.file_id ?? block.file_id ?? block.file_url };
    }
    throw new HttpError(400, `Unsupported content type: '${block.type}'`);
  });
}

function imageBlock(value, field) {
  if (typeof value !== "string" || !value) throw new HttpError(400, `${field} image source is required`);
  return value.startsWith("file_")
    ? { type: "file", path: value }
    : { type: "image_url", url: value };
}

function validateOpenAiTools(tools) {
  if (tools === undefined) return [];
  ensureArray(tools, "tools");
  return tools.map((tool, index) => {
    strictObject(tool, ["type", "function"], ["type", "function"]);
    if (tool.type !== "function") throw new HttpError(400, `Unsupported tool type at tools[${index}]`);
    return tool;
  });
}

function validateResponseTools(tools) {
  if (tools === undefined) return [];
  ensureArray(tools, "tools");
  return tools.map((tool, index) => {
    strictObject(tool, ["type", "name", "description", "parameters", "strict"], ["type", "name", "parameters"]);
    if (tool.type !== "function") throw new HttpError(400, `Unsupported tool type at tools[${index}]`);
    return tool;
  });
}

function validateAnthropicTools(tools) {
  if (tools === undefined) return [];
  ensureArray(tools, "tools");
  return tools.map((tool) => strictObject(tool, [
    "name", "description", "input_schema", "input_examples", "strict",
  ], ["name", "input_schema"]));
}

function rejectUnsupported(body, fields) {
  for (const field of fields) {
    if (body[field] !== undefined) {
      throw new HttpError(
        400,
        `'${field}' is not supported by Agent compatibility adapters`,
        "unsupported_feature",
        field,
      );
    }
  }
}

function optionalBoolean(value, field) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new HttpError(400, `'${field}' must be a boolean`, "invalid_request_error", field);
  }
}

function optionalNumber(value, field) {
  if (value !== undefined && value !== null && !Number.isFinite(value)) {
    throw new HttpError(400, `'${field}' must be a number`, "invalid_request_error", field);
  }
}

function requireUsage(usage, protocol) {
  if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) {
    throw new HttpError(
      502,
      `${protocol} requires official usage, but the selected Agent did not provide it`,
      "agent_usage_unavailable",
    );
  }
}

function assertCapabilities(capabilities, input) {
  for (const block of input) {
    const kind = block.type === "image_url" || block.type === "local_image"
      ? "image"
      : block.type === "file" ? "file" : "text";
    if (!capabilities.input.includes(kind)) {
      throw new HttpError(400, `Selected model does not support ${kind} input`, "unsupported_feature");
    }
  }
}

async function resolveInputBlock(block, files, owner) {
  if (block.type === "file" && block.path?.startsWith("file_")) {
    const file = files.require(block.path, owner);
    return file.mediaType.startsWith("image/")
      ? { type: "local_image", path: file.path, mediaType: file.mediaType }
      : { ...block, path: file.path, mediaType: file.mediaType };
  }
  if (block.type === "file" && !/^https:\/\//.test(block.path ?? "")) {
    throw new HttpError(400, "File inputs must use an uploaded file_id or HTTPS URL");
  }
  return block;
}

function standardInput(input, toolContext = {}) {
  const blocks = input.map((block) =>
    ["tool_call", "tool_result"].includes(block.type)
      ? { type: "text", text: `STANDARD_API_INPUT:\n${JSON.stringify(block)}` }
      : block);
  if (Object.keys(toolContext).length) {
    blocks.push({
      type: "text",
      text: `STANDARD_API_TOOL_CONTEXT:\n${JSON.stringify(toolContext)}`,
    });
  }
  return blocks;
}

async function* standardAgentEvents(events, includeProcessEvents) {
  for await (const event of events) {
    if (event.type === "text.delta" || event.type === "completed"
      || event.type === "interrupted") {
      yield event;
    } else if (event.type === "interaction") {
      yield {
        type: "text.delta",
        delta: `\nAGENT_INTERACTION_REQUEST:\n${JSON.stringify(event.payload)}`,
      };
    } else if (includeProcessEvents) {
      yield { type: "text.delta", delta: `\nAGENT_EVENT:\n${JSON.stringify(event)}` };
    }
  }
}

async function collect(events) {
  let text = "";
  let usage;
  let sessionId;
  let status;
  for await (const event of events) {
    if (event.type === "text.delta") text += event.delta;
    else if (event.type === "completed" || event.type === "interrupted") {
      usage = event.usage;
      sessionId = event.sessionId;
      status = event.type;
    }
  }
  if (!status) throw agentMissingTerminalError();
  return { text, usage, sessionId, status };
}

function agentMissingTerminalError() {
  const error = new Error("Agent stream ended without an official terminal event");
  error.code = "agent_protocol_error";
  return error;
}

async function* releaseWhenDone(events, release) {
  try {
    yield* events;
  } finally {
    release();
  }
}

function bearerOrApiKey(request) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  if (typeof request.headers["x-api-key"] === "string") return request.headers["x-api-key"];
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim());
  const nativeKey = protocols.find((value) => value.startsWith("allapi_native_"));
  if (nativeKey) return nativeKey;
  throw new HttpError(401, "Missing API key", "invalid_api_key");
}

function requireAccessKey(grant) {
  if (grant.kind !== "access") {
    throw new HttpError(403, "This endpoint requires an access API key", "permission_denied");
  }
}

function visibleModels(config, grant) {
  return grant.kind === "native"
    ? Object.keys(config.models)
    : grant.models.filter((id) => config.models[id]);
}

function visibleWorkspaces(config, grant) {
  return grant.kind === "native"
    ? Object.keys(config.workspaces)
    : grant.workspaces.filter((id) => config.workspaces[id]);
}

function requireModelVisible(config, grant, id) {
  if (!visibleModels(config, grant).includes(id)) {
    throw new HttpError(403, `model "${id}" is not allowed by this API key`, "permission_denied");
  }
}

function requireAnthropicVersion(request) {
  if (!request.headers["anthropic-version"]) {
    throw new HttpError(400, "anthropic-version header is required");
  }
}

function rejectUpgrade(socket, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const reason = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
  }[status] ?? "Internal Server Error";
  const body = `${error?.message ?? reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function workspaceId(request, grant) {
  return request.headers["x-allapi-workspace"] || defaultWorkspace(grant);
}

function defaultWorkspace(grant) {
  return grant.defaultWorkspace;
}

async function readJson(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  const body = await readBuffer(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function readBuffer(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error, anthropic) {
  if (response.destroyed) return;
  const status = Number.isInteger(error.status) ? error.status : 500;
  const message = status === 500 ? "Internal server error" : error.message;
  if (response.headersSent) {
    writeIfOpen(response, `${anthropic ? "event: error\n" : ""}data: ${JSON.stringify({
      type: "error",
      error: { type: error.code ?? "server_error", message },
    })}\n\n`);
    return response.end();
  }
  if (anthropic) {
    return sendJson(response, status, {
      type: "error",
      error: {
        type: anthropicErrorType(status, error.code),
        message,
      },
      request_id: `req_${crypto.randomUUID().replaceAll("-", "")}`,
    });
  }
  return sendJson(response, status, {
    error: {
      message,
      type: error.code ?? "server_error",
      param: error.parameter ?? null,
      code: error.code ?? null,
    },
  });
}

function startSse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function sendSse(response, value, event) {
  writeIfOpen(response, `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
}

function writeIfOpen(response, data) {
  if (!response.destroyed && !response.writableEnded) response.write(data);
}

function openAiUsage(usage) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

function responseUsage(usage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

function anthropicErrorType(status, code) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  return status >= 500 ? "api_error" : "invalid_request_error";
}

function ensureArray(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `'${field}' must be an array`, "invalid_request_error", field);
}

function safeFilename(filename) {
  return String(filename).replaceAll(/["\r\n]/g, "_");
}

function anthropicFile(file) {
  return {
    id: file.id,
    type: "file",
    filename: file.filename,
    mime_type: file.mediaType ?? "application/octet-stream",
    size_bytes: file.bytes,
    created_at: new Date(file.created_at * 1000).toISOString(),
    downloadable: false,
  };
}
