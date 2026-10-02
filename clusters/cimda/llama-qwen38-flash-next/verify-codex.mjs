import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Only synthetic fixtures: never read sessions, prompts, images, or server logs.
const base = process.env.QWEN_TEST_BASE ?? 'http://100.100.130.75/qwen';
const model = 'qwen3.8-flash-next-ud-iq3-xxs';
const template = await readFile(new URL('./chat-template.jinja', import.meta.url), 'utf8');
const message = (role, text) => ({
  type: 'message', role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(data.error)}`);
  return data;
}

function answer(data) {
  return (data.output ?? []).filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
    .map(item => item.text).join('');
}

assert.equal((await request('/health')).status, 'ok');
const props = await request('/props');
assert.equal(props.chat_template.trimEnd(), template.trimEnd(), 'Server did not load the Flux-managed template');
assert.match(props.model_path, /abliterated-huihui\/UD-Q4_K_XL\//);
assert.equal(props.default_generation_settings.n_ctx, 32768);
console.log('PASS: healthy server, correct checkpoint, 32K context and managed template');

const compacted = [
  message('user', 'Earlier task: arithmetic.'),
  message('user', 'Earlier result: 17 times 23 is 391.'),
  message('developer', 'Be concise and follow the latest arithmetic request.'),
  message('user', 'Continue the arithmetic task.'),
  message('user', 'Compaction summary: previous answer was 391.'),
  message('user', 'Compute 17 times 23. Reply only with the integer.'),
];
for (const effort of ['low', 'high']) {
  const result = await request('/v1/responses', {
    model, input: compacted, reasoning: { effort },
    max_output_tokens: 512, temperature: 0, store: false,
  });
  assert.equal(result.status, 'completed');
  assert.match(answer(result), /\b391\b/);
  console.log(`PASS: post-compaction developer message at ${effort} effort`);
}

const sumTool = {
  type: 'function', name: 'report_sum', description: 'Report an integer sum.',
  parameters: {
    type: 'object', properties: { sum: { type: 'integer' } },
    required: ['sum'], additionalProperties: false,
  },
  strict: true,
};
const toolInput = [
  message('user', 'Earlier task: arithmetic.'),
  message('developer', 'Use report_sum when asked to report a sum.'),
  message('user', 'Use report_sum to report 17 plus 25.'),
];
const toolResult = await request('/v1/responses', {
  model, input: toolInput, tools: [sumTool], tool_choice: 'required',
  reasoning: { effort: 'high' }, max_output_tokens: 1024, temperature: 0, store: false,
});
const call = toolResult.output.find(item => item.type === 'function_call' && item.name === 'report_sum');
assert.ok(call, 'Missing function call');
assert.equal(JSON.parse(call.arguments).sum, 42);
const followup = await request('/v1/responses', {
  model,
  input: [...toolInput, call, { type: 'function_call_output', call_id: call.call_id, output: '42' },
    message('developer', 'The tool succeeded. Reply only with the integer result.'),
    message('user', 'Give the result.')],
  tools: [sumTool], tool_choice: 'none', reasoning: { effort: 'high' },
  max_output_tokens: 512, temperature: 0, store: false,
});
assert.match(answer(followup), /\b42\b/);
console.log('PASS: high-effort function call and tool-result round trip with late developer messages');

const stream = await fetch(`${base}/v1/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model, input: compacted, reasoning: { effort: 'high' },
    max_output_tokens: 512, temperature: 0, stream: true, store: false,
  }),
  signal: AbortSignal.timeout(120_000),
});
assert.ok(stream.ok, `Streaming HTTP ${stream.status}`);
const events = (await stream.text()).split('\n')
  .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
  .map(line => JSON.parse(line.slice(6)));
assert.ok(events.some(event => event.type === 'response.completed'));
assert.match(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), /\b391\b/);
console.log('PASS: high-effort post-compaction Responses SSE streaming');

const rendered = await request('/apply-template', {
  messages: [
    { role: 'user', content: 'SYNTHETIC_OLDER_USER' },
    { role: 'developer', content: 'SYNTHETIC_LATE_DEVELOPER' },
    { role: 'user', content: 'SYNTHETIC_NEW_USER' },
  ],
  reasoning_effort: 'high',
});
const prompt = rendered.prompt;
assert.ok(prompt.indexOf('SYNTHETIC_OLDER_USER') < prompt.indexOf('<|im_start|>system\nSYNTHETIC_LATE_DEVELOPER'));
assert.ok(prompt.indexOf('SYNTHETIC_LATE_DEVELOPER') < prompt.indexOf('SYNTHETIC_NEW_USER'));
console.log('PASS: late developer instruction is rendered as system at its original history position');
