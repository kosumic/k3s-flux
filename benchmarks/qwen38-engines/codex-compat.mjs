import assert from 'node:assert/strict';
import { mkdtemp, mkdir, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

// New isolated Codex home and ephemeral thread; never enumerate/resume saved threads.
const dir = resolve(process.env.BENCH_DIR ?? '.');
await mkdir(dir, { recursive: true });
const scratch = await mkdtemp(`${dir}/codex-synthetic-`);
const engine = process.env.BENCH_ENGINE ?? 'llama';
const base = process.env.BENCH_PUBLIC_BASE ?? 'http://100.100.130.75/qwen/v1';
const config = {
  model: engine === 'llama' ? 'qwen3.8-flash-next-ud-iq3-xxs' : 'default',
  model_provider: 'benchmark', model_context_window: 32768, model_auto_compact_token_limit: 28000,
  model_reasoning_effort: 'high', model_reasoning_summary: 'none',
  'model_providers.benchmark.name': 'Synthetic engine compatibility benchmark',
  'model_providers.benchmark.base_url': base,
  'model_providers.benchmark.wire_api': 'responses',
  'model_providers.benchmark.requires_openai_auth': false,
  'model_providers.benchmark.supports_websockets': false,
};
const child = spawn('codex', ['app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], {
  cwd: scratch, env: { ...process.env, CODEX_HOME: scratch }, stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map(), notifications = [];
let nextId = 1, exited = false;
const watchers = new Set();
child.on('exit', (code, signal) => {
  exited = true;
  for (const waiter of pending.values()) waiter.reject(new Error(`app-server exited ${code}/${signal}`));
  for (const wake of watchers) wake();
});
createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line);
  if (value.id != null && pending.has(value.id)) {
    const waiter = pending.get(value.id);
    pending.delete(value.id); clearTimeout(waiter.timer);
    if (value.error) waiter.reject(new Error(JSON.stringify(value.error))); else waiter.resolve(value.result);
  } else if (value.method) {
    notifications.push(value);
    for (const wake of watchers) wake();
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} RPC timeout`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
function event(predicate, offset, timeout = 240_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Notification timeout')), timeout);
    function finish(error, value) {
      clearTimeout(timer); watchers.delete(check);
      if (error) reject(error); else resolve(value);
    }
    function check() {
      const value = notifications.slice(offset).find(predicate);
      if (value) finish(null, value); else if (exited) finish(new Error('app-server exited before notification'));
    }
    watchers.add(check); check();
  });
}
const guard = setTimeout(() => child.kill('SIGTERM'), 600_000);
let row;
const startedAt = Date.now();
try {
  await rpc('initialize', { clientInfo: { name: 'qwen_engine_benchmark', title: 'Synthetic compatibility test', version: '1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const thread = await rpc('thread/start', {
    cwd: scratch, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: 'This is a synthetic arithmetic compatibility test. Never use tools, access files, images, logs or network. Answer arithmetic directly.',
    developerInstructions: 'Keep answers concise and preserve arithmetic results through compaction.',
  });
  assert.equal(thread.modelProvider, 'benchmark');
  assert.equal(thread.reasoningEffort, 'high');
  async function turn(text, answer) {
    const offset = notifications.length;
    const started = await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text, textElements: [] }] });
    const completed = await event(x => x.method === 'turn/completed' && x.params.threadId === thread.thread.id && x.params.turn.id === started.turn.id, offset);
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
    const items = notifications.slice(offset).filter(x => x.method === 'item/completed').map(x => x.params.item);
    assert.ok(!items.some(x => ['commandExecution', 'fileChange', 'mcpToolCall'].includes(x.type)), 'Unexpected tool execution');
    assert.match(items.filter(x => x.type === 'agentMessage').map(x => x.text).join(''), new RegExp(`\\b${answer}\\b`));
  }
  await turn('Compute 17 times 23. Reply only with the integer.', 391);
  await turn('Compute 17 plus 25. Reply only with the integer.', 42);
  const offset = notifications.length;
  await rpc('thread/compact/start', { threadId: thread.thread.id });
  await event(x => x.params?.threadId === thread.thread.id && (x.method === 'thread/compacted' ||
    (x.method === 'item/completed' && x.params.item.type === 'contextCompaction')), offset);
  await turn('Continue after compaction. What was 17 times 23? Reply only with the integer.', 391);
  row = { passed: true, compaction: true, continuation: true };
  console.log(`PASS ${engine}: real Codex high-effort compaction and continuation`);
} catch (error) {
  row = { passed: false, error: error.message };
  console.log(`FAIL ${engine}: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(guard);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.stdin.end(); child.kill('SIGTERM');
  await appendFile(`${dir}/codex-compat.jsonl`, JSON.stringify({ timestamp: new Date().toISOString(), engine, block: Number(process.env.BENCH_BLOCK ?? 0), phase: 'compatibility', id: 'real_codex_compaction', latency_ms: Date.now() - startedAt, ...row }) + '\n');
}
