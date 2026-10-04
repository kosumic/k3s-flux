import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseEvent, qualityFixtures, streamRequest } from './bench.mjs';

test('SSE parser handles comments, done and multiline data', () => {
  assert.equal(parseEvent(': keepalive'), null);
  assert.equal(parseEvent('data: [DONE]'), null);
  assert.deepEqual(parseEvent('event: delta\ndata: {"value":\ndata: 42}'), { value: 42 });
});

test('100 deterministic, paired objective quality fixtures', () => {
  const fixtures = qualityFixtures();
  assert.equal(fixtures.length, 100);
  assert.equal(new Set(fixtures.map(x => x.id)).size, 100);
  for (const category of ['arithmetic', 'coding', 'retrieval', 'tool']) assert.equal(fixtures.filter(x => x.category === category).length, 25);
  assert.deepEqual(fixtures, qualityFixtures());
});

async function serve(events, action) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
    res.write(content.slice(0, 13));
    setTimeout(() => res.end(content.slice(13)), 5);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('stream counts usage including reasoning, not chunks', async () => {
  await serve([
    { choices: [{ text: 'reasoning</think>Answer' }] },
    { choices: [{ text: '', finish_reason: 'length' }], usage: { completion_tokens: 7, prompt_tokens: 512 } },
  ], async url => {
    const result = await streamRequest(url, { max_tokens: 7 });
    assert.equal(result.completion_tokens, 7);
    assert.equal(result.prompt_tokens, 512);
    assert.equal(result.count_source, 'server_usage');
    assert.ok(result.ttft_ms >= 0);
    assert.ok(result.first_answer_ms >= 0);
  });
});

test('missing usage is usable only when verified length cap is reached', async () => {
  await serve([{ choices: [{ text: 'x', finish_reason: 'length' }] }], async url => {
    assert.equal((await streamRequest(url, { max_tokens: 512 })).completion_tokens, 512);
  });
  await serve([{ choices: [{ text: 'x', finish_reason: 'stop' }] }], async url => {
    await assert.rejects(streamRequest(url, { max_tokens: 512 }), /token count unavailable/);
  });
});

test('stream errors and incomplete streams are failures', async () => {
  await serve([{ error: { message: 'synthetic failure' } }], async url => {
    await assert.rejects(streamRequest(url, { max_tokens: 1 }), /synthetic failure/);
  });
  await serve([{ choices: [{ text: 'unfinished' }] }], async url => {
    await assert.rejects(streamRequest(url, { max_tokens: 1 }), /without finish_reason/);
  });
});
