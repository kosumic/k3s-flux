import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Only generated fixtures and benchmark-owned artifacts are read or written.
const exec = promisify(execFile);
const base = process.env.BENCH_BASE ?? 'http://10.43.162.181:8080';
const root = process.env.BENCH_DIR ?? process.cwd();
const engine = process.env.BENCH_ENGINE ?? 'llama';
const block = Number(process.env.BENCH_BLOCK ?? 0);
const repeats = Number(process.env.BENCH_REPEATS ?? 30);
const warmups = Number(process.env.BENCH_WARMUPS ?? 2);
const sha = text => createHash('sha256').update(text).digest('hex');
const timestamp = () => new Date().toISOString();

export function parseEvent(frame) {
  const data = frame.split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

async function json(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

async function record(row) {
  await appendFile(`${root}/requests.jsonl`, JSON.stringify({ timestamp: timestamp(), engine, block, ...row }) + '\n');
}

async function tokenize(content) {
  return (await json('/tokenize', { content, add_special: false, parse_special: true })).tokens;
}

async function prepare() {
  await mkdir(root, { recursive: true });
  const fixtures = { created: timestamp(), context: 32768, reasoning: 'high', prompts: {}, quality: [] };
  const filler = Array.from({ length: 4000 }, (_, i) =>
    `Synthetic record ${i}: ${['amber', 'birch', 'cobalt', 'delta', 'elm'][i % 5]} item ${i * 17 + 3} has score ${i % 97}.\n`).join('');
  const all = await tokenize(filler);
  for (const length of [512, 2048, 8192, 16384, 28672]) {
    fixtures.prompts[length] = [];
    for (let i = 0; i < 128; i++) {
      const seed = `BENCH-${block}-${length}-${i}-${sha(String(i)).slice(0, 16)}`;
      const rendered = (await json('/apply-template', {
        messages: [{ role: 'system', content: `${seed}: Use only the synthetic records. Keep reasoning concise.` },
          { role: 'user', content: 'DATA_PLACEHOLDER\nWrite a long numbered analysis of the records without stopping early.' }],
        reasoning_effort: 'high',
      })).prompt;
      // Slice tokenizer IDs, then round-trip to prove the exact total input length.
      const [prefix, suffix] = rendered.split('DATA_PLACEHOLDER');
      assert.ok(suffix);
      const overhead = (await tokenize(prefix + suffix)).length;
      let take = length - overhead - 8;
      let prompt, count;
      for (let attempt = 0; attempt < 24; attempt++) {
        let body = (await json('/detokenize', { tokens: all.slice(0, take) })).content;
        prompt = prefix + body + suffix;
        count = (await tokenize(prompt)).length;
        if (count === length) break;
        if (count < length && length - count < 24) {
          body += ' !'.repeat(length - count);
          prompt = prefix + body + suffix;
          count = (await tokenize(prompt)).length;
          if (count === length) break;
        }
        take += count > length ? -1 : 1;
      }
      assert.equal(count, length, 'Could not calibrate input length');
      fixtures.prompts[length].push({ prompt, tokens: count, sha256: sha(prompt) });
    }
    console.log(`Prepared ${length}-token fixtures`);
  }
  fixtures.prefix = fixtures.prompts[8192][0].prompt;
  fixtures.quality = qualityFixtures();
  await writeFile(`${root}/fixtures.json`, JSON.stringify(fixtures));
  await writeFile(`${root}/fixtures.sha256`, sha(JSON.stringify(fixtures)) + '\n');
}

export function qualityFixtures() {
  const tests = [];
  for (let i = 0; i < 25; i++) {
    const a = 31 + i * 7, b = 13 + i * 3, c = i % 7 + 2;
    tests.push({ id: `arithmetic-${i}`, category: 'arithmetic',
      prompt: `Compute (${a} * ${b}) - (${c} * ${a}) + ${b}. Reply only with the integer.`, expected: String(a * b - c * a + b) });
    const records = Array.from({ length: 150 }, (_, j) => `key-${j}: value-${(j * 31 + i * 11) % 10007}`).join('\n');
    const key = (i * 23 + 19) % 150;
    tests.push({ id: `retrieval-${i}`, category: 'retrieval', prompt: `${records}\nReturn only the exact value for key-${key}.`, expected: `value-${(key * 31 + i * 11) % 10007}` });
    tests.push({ id: `tool-${i}`, category: 'tool', prompt: `Call report_sum with sum equal to ${a} plus ${b}.`, expected: a + b });
    const coding = [
      ['Return a new array of the input integers in ascending numerical order.', [3 + i, -i, 3 + i, 0], [-i, 0, 3 + i, 3 + i]],
      ['Return an array of the unique input integers, preserving their first occurrence order.', [i, 2, i, 3, 2], [...new Set([i, 2, i, 3, 2])]],
      ['Return the sum of each input integer squared.', [i, -3, 2], i * i + 13],
      ['Rotate the input array one position left, preserving empty arrays.', [i, 2, 3], [2, 3, i]],
      ['Return true if the input integer is prime; false for integers less than two.', 29 + i, isPrime(29 + i)],
    ][i % 5];
    tests.push({ id: `coding-${i}`, category: 'coding',
      prompt: `Write only JavaScript code declaring function solve(x). ${coding[0]} No imports, I/O, or Markdown.`, input: coding[1], expected: coding[2], family: i % 5 });
  }
  return tests;
}

function isPrime(n) {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

function modelName() {
  return engine === 'llama' ? 'qwen3.8-flash-next-ud-iq3-xxs' : 'default';
}

export async function streamRequest(url, body) {
  const start = performance.now();
  let first = null, last = null, visible = null, output = '', reason = null, usage = null, logprobTokens = 0;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  let pending = '';
  const decoder = new TextDecoder();
  function consume(frame) {
    const event = parseEvent(frame);
    if (!event) return;
    if (event.error) throw new Error(JSON.stringify(event.error));
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    const text = choice?.text ?? choice?.delta?.reasoning_content ?? choice?.delta?.content ?? '';
    const tokens = choice?.logprobs?.tokens?.length ?? 0;
    logprobTokens += tokens;
    if (text || tokens) {
      const now = performance.now();
      first ??= now;
      last = now;
      output += text;
      if (output.includes('</think>') && output.split('</think>').slice(1).join('').trim()) visible ??= now;
    }
    if (choice?.finish_reason) reason = choice.finish_reason;
  }
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      consume(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  assert.ok(reason, 'Stream ended without finish_reason');
  const tokens = usage?.completion_tokens ?? (reason === 'length' ? body.max_tokens : null);
  assert.ok(Number.isInteger(tokens), 'Output token count unavailable');
  return {
    ok: true, ttft_ms: first === null ? null : first - start,
    first_answer_ms: visible === null ? null : visible - start,
    latency_ms: performance.now() - start, completion_tokens: tokens, prompt_tokens: usage?.prompt_tokens ?? null,
    decode_tps: tokens > 1 && last > first ? (tokens - 1) * 1000 / (last - first) : null,
    finish_reason: reason, count_source: usage ? 'server_usage' : 'verified_length_cap',
    logprob_tokens: logprobTokens, usage, output_sha256: sha(output), output,
  };
}

async function telemetry() {
  try {
    const [gpus, apps] = await Promise.all([
      exec('nvidia-smi', ['--query-gpu=index,uuid,memory.used,memory.total,utilization.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 5000 }),
      exec('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits'], { timeout: 5000 }),
    ]);
    const processes = apps.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [gpu, pid, name, mib] = line.split(',').map(x => x.trim());
      return { gpu, pid: Number(pid), name, mib: Number(mib), engine: name.split('/').at(-1) === (engine === 'llama' ? 'llama-server' : 'mistralrs') };
    });
    const pids = [...new Set(processes.filter(p => p.engine).map(p => p.pid))];
    const host = [];
    for (const pid of pids) {
      // Resource counters only; never cmdline, environ, user files, or inference logs.
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const values = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      host.push({ pid, rss_kib: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
        cpu_ticks: Number(values[11]) + Number(values[12]) });
    }
    await appendFile(`${root}/telemetry.jsonl`, JSON.stringify({ timestamp: timestamp(), engine, block, gpu_csv: gpus.stdout.trim(), processes, host }) + '\n');
  } catch (error) { await appendFile(`${root}/telemetry.jsonl`, JSON.stringify({ timestamp: timestamp(), engine, block, error: error.message }) + '\n'); }
}

async function performanceSuite() {
  const fixtures = JSON.parse(await readFile(`${root}/fixtures.json`, 'utf8'));
  const cells = [
    ...[512, 2048, 8192, 16384, 28672].map(input => ({ name: `prefill-${input}`, input, output: 1 })),
    ...[512, 8192].map(input => ({ name: `decode-${input}`, input, output: 512 })),
    { name: 'long-2048', input: 2048, output: 2048 },
    { name: 'prefix-8192', input: 8192, output: 256, cached: true },
    ...[1, 2, 4].map(clients => ({ name: `queued-${clients}`, input: 2048, output: 256, clients })),
  ].filter(cell => !process.env.BENCH_CELLS || process.env.BENCH_CELLS.split(',').includes(cell.name));
  let busy = false;
  await telemetry();
  const sampler = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await telemetry(); } finally { busy = false; }
  }, 2000);
  try {
    for (const cell of cells) {
      // Verify native prompt accounting using non-streaming usage, not an estimated tokenizer.
      const calibration = await json('/v1/completions', { model: modelName(), prompt: fixtures.prompts[cell.input][127].prompt,
        max_tokens: 1, temperature: 0, ignore_eos: true, cache_prompt: false });
      assert.equal(calibration.usage.prompt_tokens, cell.input, `${engine} tokenizer mismatch for ${cell.name}`);
      await record({ phase: 'calibration', cell: cell.name, expected_prompt_tokens: cell.input, usage: calibration.usage });
      for (let round = -warmups; round < repeats; round++) {
        const batchStart = performance.now();
        const results = await Promise.all(Array.from({ length: cell.clients ?? 1 }, async (_, client) => {
          const fixture = fixtures.prompts[cell.input][(round + warmups) * (cell.clients ?? 1) + client];
          const prompt = cell.cached ? `${fixtures.prefix}\nQuestion ${round + warmups}: analyze item ${client}.` : fixture.prompt;
          try {
            const result = await streamRequest(`${base}/v1/completions`, { model: modelName(), prompt, max_tokens: cell.output,
              temperature: 0, ignore_eos: true, seed: 42, stream: true, stream_options: { include_usage: true },
              cache_prompt: Boolean(cell.cached) });
            delete result.output;
            assert.equal(result.completion_tokens, cell.output);
            const row = { phase: round < 0 ? 'warmup' : 'measured', cell: cell.name, round, client,
              expected_prompt_tokens: cell.cached ? null : cell.input, prompt_sha256: sha(prompt), ...result };
            await record(row);
            return row;
          } catch (error) {
            const row = { phase: round < 0 ? 'warmup' : 'measured', cell: cell.name, round, client, ok: false, error: error.message };
            await record(row);
            return row;
          }
        }));
        await record({ phase: round < 0 ? 'warmup_batch' : 'batch', cell: cell.name, round,
          wall_ms: performance.now() - batchStart, successful_tokens: results.filter(r => r.ok).reduce((n, r) => n + r.completion_tokens, 0),
          failures: results.filter(r => !r.ok).length });
        console.log(`${timestamp()} ${engine} block=${block} ${cell.name} round=${round} ok=${results.filter(r => r.ok).length}/${results.length}`);
        if (results.every(r => !r.ok)) throw new Error(`All requests failed in ${cell.name}; stopping block`);
      }
    }
  } finally { clearInterval(sampler); await telemetry(); }
}

async function runCode(code, test) {
  const source = code.replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/, '');
  const cases = [[test.input, test.expected], ...({
    0: [[[], []], [[10, 2, -1], [-1, 2, 10]]],
    1: [[[], []], [[2, 1, 2], [2, 1]]],
    2: [[[], 0], [[-2, 0, 3], 13]],
    3: [[[], []], [[7], [7]], [[1, 2], [2, 1]]],
    4: [[-1, false], [1, false], [2, true], [25, false], [31, true]],
  }[test.family])];
  const script = `const vm=require('node:vm'),assert=require('node:assert/strict');const ctx=vm.createContext({});` +
    `vm.runInContext(${JSON.stringify(source)},ctx,{timeout:1000});` +
    `for(const [x,want] of ${JSON.stringify(cases)}){ctx.x=x;const out=vm.runInContext('solve(x)',ctx,{timeout:1000});` +
    `assert.equal(JSON.stringify(out),JSON.stringify(want));}console.log('PASS');`;
  const name = `qwen-bench-code-${engine}-${test.id}`;
  try {
    const result = await exec('docker', ['run', '--rm', '--name', name, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--memory', '128m', '--cpus', '1',
      '--pids-limit', '64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402', 'node', '-e', script], { timeout: 10_000, maxBuffer: 4096 });
    return result.stdout.trim() === 'PASS';
  } catch { return false; }
  finally { await exec('docker', ['rm', '-f', name], { timeout: 5000 }).catch(() => {}); }
}

async function qualitySuite() {
  const fixtures = JSON.parse(await readFile(`${root}/fixtures.json`, 'utf8'));
  for (const test of fixtures.quality) {
    const start = performance.now();
    try {
      const tool = { type: 'function', function: { name: 'report_sum', description: 'Report the sum.',
        parameters: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }, strict: true } };
      const response = await json('/v1/chat/completions', { model: modelName(),
        messages: [{ role: 'system', content: 'This is a synthetic benchmark. Reason concisely and follow the requested output format.' },
          { role: 'user', content: test.prompt }], reasoning_effort: 'high', temperature: 0, max_tokens: 2048,
        ...(test.category === 'tool' ? { tools: [tool], tool_choice: 'required' } : {}) });
      const answer = response.choices[0].message;
      let passed;
      if (test.category === 'tool') {
        const call = answer.tool_calls?.find(x => x.function.name === 'report_sum');
        passed = Boolean(call) && JSON.parse(call.function.arguments).sum === test.expected;
      } else if (test.category === 'coding') passed = await runCode(answer.content ?? '', test);
      else passed = (answer.content ?? '').trim() === test.expected;
      await record({ phase: 'quality', id: test.id, category: test.category, passed, ok: true,
        latency_ms: performance.now() - start, usage: response.usage, answer });
      console.log(`QUALITY ${engine} ${test.id}: ${passed ? 'PASS' : 'FAIL'}`);
    } catch (error) {
      await record({ phase: 'quality', id: test.id, category: test.category, passed: false, ok: false, error: error.message });
    }
  }
}

async function compatibility() {
  const msg = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
  const input = [msg('user', 'Earlier arithmetic result was 391.'), msg('developer', 'Follow the latest arithmetic request.'),
    msg('user', 'Compute 17 times 23. Reply only with the integer.')];
  const tool = { type: 'function', name: 'report_sum', description: 'Report an integer sum.', strict: true,
    parameters: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false } };
  const outputText = result => (result.output ?? []).filter(x => x.type === 'message').flatMap(x => x.content ?? [])
    .filter(x => x.type === 'output_text').map(x => x.text).join('');
  const tests = {
    async responses_late_developer() {
      const result = await json('/v1/responses', { model: modelName(), input, reasoning: { effort: 'high' }, temperature: 0, max_output_tokens: 512, store: false });
      assert.equal(result.status, 'completed'); assert.match(outputText(result), /\b391\b/);
    },
    async responses_tool_roundtrip() {
      const query = [msg('user', 'Earlier arithmetic task.'), msg('developer', 'Use the report_sum tool when requested.'), msg('user', 'Call report_sum for 17 plus 25.')];
      const result = await json('/v1/responses', { model: modelName(), input: query, tools: [tool], tool_choice: 'required', reasoning: { effort: 'high' }, temperature: 0, max_output_tokens: 1024, store: false });
      const call = result.output.find(x => x.type === 'function_call' && x.name === 'report_sum');
      assert.ok(call); assert.equal(JSON.parse(call.arguments).sum, 42);
      const followup = await json('/v1/responses', { model: modelName(), input: [...query, call,
        { type: 'function_call_output', call_id: call.call_id, output: '42' }, msg('developer', 'Reply only with the tool result.'), msg('user', 'Give the result.')],
        tools: [tool], tool_choice: 'none', reasoning: { effort: 'high' }, temperature: 0, max_output_tokens: 512, store: false });
      assert.match(outputText(followup), /\b42\b/);
    },
    async responses_stream() {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName(), input, reasoning: { effort: 'high' }, temperature: 0, max_output_tokens: 512, stream: true, store: false }), signal: AbortSignal.timeout(120_000) });
      assert.ok(response.ok, `HTTP ${response.status}`);
      const events = (await response.text()).replaceAll('\r\n', '\n').split('\n\n').map(parseEvent).filter(Boolean);
      assert.ok(events.some(x => x.type === 'response.completed'));
      assert.match(events.filter(x => x.type === 'response.output_text.delta').map(x => x.delta).join(''), /\b391\b/);
    },
  };
  for (const [id, test] of Object.entries(tests)) {
    try { await test(); await record({ phase: 'compatibility', id, passed: true }); console.log(`COMPAT ${engine} ${id}: PASS`); }
    catch (error) { await record({ phase: 'compatibility', id, passed: false, error: error.message }); console.log(`COMPAT ${engine} ${id}: FAIL ${error.message}`); }
  }
}

async function monitor() {
  while (true) {
    try { await readFile(`${root}/stop-monitor-${engine}-${block}`); break; } catch {}
    await telemetry();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 30);
  await mkdir(root, { recursive: true });
  const command = process.argv[2];
  if (command === 'prepare') await prepare();
  else if (command === 'perf') await performanceSuite();
  else if (command === 'quality') await qualitySuite();
  else if (command === 'compat') await compatibility();
  else if (command === 'monitor') await monitor();
  else throw new Error('Usage: node bench.mjs prepare|perf|quality|compat|monitor');
}
