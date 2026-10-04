import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, pairedInterval } from './report.mjs';
test('statistics omit missing metrics and retain zero', () => {
  assert.equal(percentile([0, 10, NaN, null], 0.5), 5);
  assert.deepEqual(summarize([{ n: 0 }, { n: 10 }, { n: null }], 'n'), { n: 2, median: 5, p95: 9.5 });
});
test('paired bootstrap requires matching blocks, rounds and clients', () => {
  const rows = [1, 2, 3].flatMap(block => ['llama', 'mistral'].flatMap(engine => [0, 1, 2].map(round => ({
    block, engine, round, client: 0, cell: 'sample', ok: true, latency_ms: engine === 'llama' ? 100 : 80,
  }))));
  const result = pairedInterval(rows, 'sample', 'latency_ms', 100);
  assert.equal(result.pairs, 9); assert.equal(result.blocks, 3);
  assert.deepEqual(result.improvement_pct_ci95, [20, 20]);
  assert.equal(pairedInterval(rows, 'absent', 'latency_ms'), null);
});
