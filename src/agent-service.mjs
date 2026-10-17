import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv from 'ajv';
import { AgentCard, Task, TaskState as S, Role } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { HttpError, requireGrant } from './core.mjs';

export const EXECUTION_EXTENSION = 'urn:all-api:execution:1';
const active = state => [S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING].includes(state);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const malformed = message => new RequestMalformedError({ message });
const ajv = new Ajv({ strict: false, allErrors: false });

// Generic, tenant-scoped execution. Application identities, memory and prompts
// belong to callers. Native session identifiers never cross this interface.
export class AgentService {
  constructor({ config, directory, prepareRun, origin }) {
    Object.assign(this, { config, prepareRun, origin });
    this.running = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(path.join(directory, 'owner.sqlite'));
    chmodSync(path.join(directory, 'owner.sqlite'), 0o600);
    try { this.lock.exec('BEGIN EXCLUSIVE'); }
    catch (error) { this.lock.close(); throw new Error('Agent execution store is already in use', { cause: error }); }
    this.db = new DatabaseSync(path.join(directory, 'executions.sqlite'));
    chmodSync(path.join(directory, 'executions.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS contexts(owner TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,workspace TEXT NOT NULL,engine TEXT NOT NULL,session TEXT,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS tasks(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,context TEXT NOT NULL,message TEXT NOT NULL,digest TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,state INTEGER NOT NULL,UNIQUE(owner,message));
      CREATE INDEX IF NOT EXISTS task_context ON tasks(owner,context,seq);
      CREATE INDEX IF NOT EXISTS task_state ON tasks(state,seq);
      CREATE INDEX IF NOT EXISTS owner_task_state ON tasks(owner,state);
    `);
    for (const row of this.db.prepare("SELECT result FROM tasks WHERE state=2").all()) {
      this.finish(JSON.parse(row.result), S.TASK_STATE_FAILED, 'Execution interrupted; inspect effects before submitting further work.', { outcome: 'unconfirmed' });
    }
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
  }
  authorize(grant) {
    if (grant.kind !== 'access') throw new HttpError(403, 'An access key is required', 'permission_denied');
  }
  async getAgentCard(grant) {
    this.authorize(grant);
    return AgentCard.fromJSON({
      name: 'All API', description: 'Unified agent execution with durable tasks and caller-owned contexts.', version: '1.0.0',
      supportedInterfaces: [{ url: `${this.origin()}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: EXECUTION_EXTENSION, required: true,
        description: 'Caller contextId; metadata.execution selects agent, instructions and optional JSON responseSchema. Durable message identity scoped to the access key; structured results and uniform terminal states.' }] },
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
      securityRequirements: [{ schemes: { bearer: [] } }],
      skills: grant.models.map(id => ({ id, name: id, description: 'Execute using this configured agent profile.', tags: ['agent'] })),
    });
  }
  async rpc(body, grant, headers) {
    this.authorize(grant);
    if (headers['a2a-version'] !== '1.0' || !String(headers['a2a-extensions'] ?? '').split(',').map(x => x.trim()).includes(EXECUTION_EXTENSION)) {
      throw new HttpError(400, `A2A-Version: 1.0 and A2A-Extensions: ${EXECUTION_EXTENSION} are required`);
    }
    if (!['SendMessage', 'GetTask', 'CancelTask'].includes(body.method)) return { jsonrpc: '2.0', id: body.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(new UnsupportedOperationError()) };
    // A handler per call keeps concurrent users isolated across awaits.
    return new JsonRpcTransportHandler({
      getAgentCard: () => this.getAgentCard(grant),
      sendMessage: p => this.sendMessage(p, grant),
      getTask: p => this.getTask(p, grant),
      cancelTask: p => this.cancelTask(p, grant),
    }).handle(body, new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: grant.keyId } }));
  }
  async sendMessage(params, grant) {
    const m = params.message, c = params.configuration;
    if (params.tenant || !m || m.role !== Role.ROLE_USER || !/^[\w-]{1,128}$/.test(m.messageId)
      || !/^[\w-]{1,128}$/.test(m.contextId) || m.taskId || m.referenceTaskIds.length || m.parts.length !== 1
      || m.parts[0].content?.$case !== 'text' || m.parts[0].filename
      || (m.parts[0].mediaType && m.parts[0].mediaType !== 'text/plain')) throw malformed('A user text message with messageId and caller contextId is required');
    const text = m.parts[0].content.value, execution = m.metadata?.execution;
    if (!text.trim() || Buffer.byteLength(text) > 128 * 1024) throw malformed('Input exceeds 128 KiB or is empty');
    if (!execution || typeof execution.agent !== 'string' || Object.keys(execution).some(k => !['agent', 'instructions', 'responseSchema'].includes(k))) throw malformed('metadata.execution requires agent and optional instructions/responseSchema');
    const instructions = execution.instructions ?? '';
    if (typeof instructions !== 'string' || Buffer.byteLength(instructions) > 128 * 1024) throw malformed('Instructions exceed 128 KiB');
    if (c?.taskPushNotificationConfig || c?.acceptedOutputModes?.some(x => !['text/plain', 'application/json'].includes(x))) throw malformed('Only polling with text or JSON output is supported');
    if (execution.responseSchema !== undefined) {
      if (typeof execution.responseSchema !== 'object' || execution.responseSchema === null || Buffer.byteLength(JSON.stringify(execution.responseSchema)) > 65536) throw malformed('Invalid responseSchema');
      try { const validate = ajv.compile(execution.responseSchema); ajv.removeSchema(execution.responseSchema); void validate; }
      catch { throw malformed('responseSchema must be a valid self-contained JSON schema'); }
    }
    const model = execution.agent, workspace = grant.defaultWorkspace;
    requireGrant(grant, 'model', model); requireGrant(grant, 'workspace', workspace);
    const profile = this.config.models[model];
    if (!profile) throw malformed('Unknown agent');
    const request = { text, instructions, responseSchema: execution.responseSchema };
    const digest = hash({ context: m.contextId, model, workspace, ...request });
    const previous = this.db.prepare('SELECT * FROM tasks WHERE owner=? AND message=?').get(grant.keyId, m.messageId);
    let task;
    if (previous) {
      if (previous.digest !== digest) throw malformed('messageId was used with different content or execution settings');
      task = JSON.parse(previous.result);
    } else {
      if (this.db.prepare("SELECT count(*) AS n FROM tasks WHERE owner=? AND state IN (1,2)").get(grant.keyId).n >= 256) throw malformed('Execution queue is full');
      const context = this.context(grant.keyId, m.contextId);
      if (context && (context.model !== model || context.workspace !== workspace || context.engine !== profile.agent)) throw malformed('Context execution profile changed; create a new context and supply application history');
      task = Task.fromJSON({ id: randomUUID(), contextId: m.contextId, status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() } });
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR IGNORE INTO contexts(owner,id,model,workspace,engine) VALUES(?,?,?,?,?)').run(grant.keyId, m.contextId, model, workspace, profile.agent);
        this.db.prepare('INSERT INTO tasks(id,owner,context,message,digest,request,result,state) VALUES(?,?,?,?,?,?,?,1)').run(task.id, grant.keyId, m.contextId, m.messageId, digest, JSON.stringify(request), JSON.stringify(task));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.wake();
    if (!c?.returnImmediately) while (!this.closed && active(task.status.state)) { await delay(100); task = await this.getTask({ id: task.id }, grant); }
    return task;
  }
  context(owner, id) { return this.db.prepare('SELECT * FROM contexts WHERE owner=? AND id=?').get(owner, id); }
  async getTask({ id, tenant }, grant) {
    if (tenant) throw malformed('Tenant prefixes are unsupported; access keys provide isolation');
    const row = this.db.prepare('SELECT result FROM tasks WHERE id=? AND owner=?').get(id, grant.keyId);
    if (!row) throw new TaskNotFoundError();
    return JSON.parse(row.result);
  }
  async cancelTask(params, grant) {
    const task = await this.getTask(params, grant);
    if (task.status.state !== S.TASK_STATE_SUBMITTED) throw new TaskNotCancelableError();
    this.finish(task, S.TASK_STATE_CANCELED, 'Canceled before execution.', { outcome: 'not_started' });
    return task;
  }
  save(task) { this.db.prepare('UPDATE tasks SET result=?,state=? WHERE id=?').run(JSON.stringify(task), task.status.state, task.id); }
  finish(task, state, text, metadata, data) {
    task.status = { state, timestamp: new Date().toISOString() };
    task.metadata = metadata;
    task.artifacts = [{ artifactId: task.id, name: 'result', description: '', extensions: [], parts: [{
      content: data === undefined ? { $case: 'text', value: text } : { $case: 'data', value: data },
      filename: '', mediaType: data === undefined ? 'text/plain' : 'application/json',
    }] }];
    this.save(task);
  }
  wake() {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT * FROM tasks WHERE state=1 ORDER BY seq").all();
    for (const row of rows) {
      if (this.running.size >= this.config.server.maxConcurrent) break;
      const key = JSON.stringify([row.owner, row.context]);
      if (this.running.has(key)) continue;
      // Defer run until the context reservation is present.
      const promise = Promise.resolve().then(() => this.run(row)).catch(() => {}).finally(() => { this.running.delete(key); });
      this.running.set(key, promise);
    }
  }
  async run(row) {
    const task = JSON.parse(row.result), context = this.context(row.owner, row.context), request = JSON.parse(row.request);
    let run;
    try {
      const record = this.config.keys[row.owner];
      if (!record) throw new Error('Credential revoked');
      if (this.config.models[context.model]?.agent !== context.engine) throw new Error('Execution engine changed; use a new context');
      run = await this.prepareRun({ keyId: row.owner, ...record }, context.model, context.workspace, {
        protocol: 'responses', rawEvents: true, input: [{ type: 'text', text: request.text }],
        instructions: request.instructions, responseSchema: request.responseSchema,
        sessionId: context.session || undefined,
        onSession: id => this.db.prepare('UPDATE contexts SET session=? WHERE owner=? AND id=?').run(id, row.owner, row.context),
      });
    } catch (error) {
      if (error.status === 429) return;
      this.finish(task, S.TASK_STATE_FAILED, 'Agent could not start. Check the execution service configuration.', { outcome: 'not_started', code: error.code ?? 'agent_unavailable' });
      return;
    }
    const latest = JSON.parse(this.db.prepare('SELECT result FROM tasks WHERE id=?').get(task.id).result);
    if (this.closed || latest.status.state !== S.TASK_STATE_SUBMITTED || !this.config.keys[row.owner]) {
      run.discard();
      if (!this.closed && latest.status.state === S.TASK_STATE_SUBMITTED) this.finish(task, S.TASK_STATE_FAILED, 'Credential revoked.', { outcome: 'not_started' });
      return;
    }
    task.status = { state: S.TASK_STATE_WORKING, timestamp: new Date().toISOString() }; this.save(task);
    let output = '', structured, completed = false;
    try {
      for await (const event of run.events) {
        if (event.type === 'text.delta') { output += event.delta; if (Buffer.byteLength(output) > 1024 * 1024) { run.controller.abort(); throw new Error('Output exceeds limit'); } }
        if (event.type === 'structured') structured = event.data;
        if (event.type === 'completed') {
          if (request.responseSchema) {
            const result = structured !== undefined ? structured : JSON.parse(output);
            const validate = ajv.compile(request.responseSchema);
            ajv.removeSchema(request.responseSchema);
            if (!validate(result) || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('Structured output does not match schema');
            this.finish(task, S.TASK_STATE_COMPLETED, '', { outcome: 'completed' }, result);
          } else this.finish(task, S.TASK_STATE_COMPLETED, output, { outcome: 'completed' });
          completed = true;
        }
        if (event.type === 'interrupted') {
          this.finish(task, S.TASK_STATE_INPUT_REQUIRED, 'Execution requires authorization from the agent service operator.', { outcome: 'input_required', code: 'approval_required' });
          completed = true;
        }
      }
      if (!completed) throw new Error('Execution ended without final status');
    } catch {
      this.finish(task, S.TASK_STATE_FAILED, 'Execution or result validation interrupted. Inspect effects before continuing.', { outcome: 'unconfirmed' });
    }
  }
  stop() { this.closed = true; clearInterval(this.timer); }
  async close() { this.stop(); await Promise.all([...this.running.values()]); this.db.close(); this.lock.close(); }
}
