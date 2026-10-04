import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  return sorted[Math.floor(position)] + (position % 1) * (sorted[Math.ceil(position)] - sorted[Math.floor(position)]);
}
export function summarize(rows, field) {
  const values = rows.map(x => x[field]).filter(Number.isFinite);
  return { n: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

async function lines(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function pairedInterval(rows, cell, field, trials = 2000) {
  const a = rows.filter(x => x.engine === 'llama' && x.cell === cell && x.ok && Number.isFinite(x[field]));
  const b = new Map(rows.filter(x => x.engine === 'mistral' && x.cell === cell && x.ok && Number.isFinite(x[field]))
    .map(x => [`${x.block}:${x.round}:${x.client}`, x]));
  const pairs = a.filter(x => b.has(`${x.block}:${x.round}:${x.client}`)).map(x => [x, b.get(`${x.block}:${x.round}:${x.client}`)]);
  if (!pairs.length) return null;
  const blocks = [...new Set(pairs.map(x => x[0].block))];
  let seed = 12345;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const estimates = [];
  for (let trial = 0; trial < trials; trial++) {
    const sample = [];
    for (let i = 0; i < blocks.length; i++) {
      const pool = pairs.filter(x => x[0].block === blocks[Math.floor(random() * blocks.length)]);
      for (let j = 0; j < pool.length; j++) sample.push(pool[Math.floor(random() * pool.length)]);
    }
    const left = percentile(sample.map(x => x[0][field]), 0.5), right = percentile(sample.map(x => x[1][field]), 0.5);
    estimates.push((left - right) / left * 100);
  }
  return { pairs: pairs.length, blocks: blocks.length, improvement_pct_ci95: [percentile(estimates, 0.025), percentile(estimates, 0.975)] };
}

export async function generateReport(dir) {
  await mkdir(dir, { recursive: true });
  const raw = await lines(`${dir}/requests.jsonl`);
  const measured = raw.filter(x => x.phase === 'measured' && x.block > 0);
  const quality = raw.filter(x => x.phase === 'quality' && x.block > 0);
  const compatibility = [...raw.filter(x => x.phase === 'compatibility'), ...await lines(`${dir}/codex-compat.jsonl`)];
  const telemetry = (await lines(`${dir}/telemetry.jsonl`)).filter(x => x.block > 0);
  let state = {};
  try { state = JSON.parse(await readFile(`${dir}/state.json`, 'utf8')); } catch {}
  const format = (n, decimals = 2) => n === null || !Number.isFinite(n) ? '—' : n.toFixed(decimals);
  const cells = [...new Set(measured.map(x => x.cell))];
  const stats = cells.map(cell => {
    const engines = Object.fromEntries(['llama', 'mistral'].map(engine => {
      const rows = measured.filter(x => x.cell === cell && x.engine === engine);
      const passed = rows.filter(x => x.ok);
      const batch = raw.filter(x => x.phase === 'batch' && x.cell === cell && x.engine === engine && x.block > 0);
      return [engine, { attempts: rows.length, errors: rows.filter(x => !x.ok).length,
        ttft_ms: summarize(passed, 'ttft_ms'), first_answer_ms: summarize(passed, 'first_answer_ms'),
        latency_ms: summarize(passed, 'latency_ms'), decode_tps: summarize(passed, 'decode_tps'),
        successful_aggregate_tps: batch.length ? batch.reduce((n, x) => n + x.successful_tokens, 0) * 1000 / batch.reduce((n, x) => n + x.wall_ms, 0) : null }];
    }));
    return { cell, ...engines, ttft_interval: pairedInterval(measured, cell, 'ttft_ms'), latency_interval: pairedInterval(measured, cell, 'latency_ms') };
  });
  const scores = ['llama', 'mistral'].map(engine => ({ engine,
    categories: Object.fromEntries(['arithmetic', 'coding', 'retrieval', 'tool'].map(category => {
      const rows = quality.filter(x => x.engine === engine && x.category === category);
      return [category, { passed: rows.filter(x => x.passed).length, total: rows.length }];
    })), compatibility: compatibility.filter(x => x.engine === engine) }));
  const memory = ['llama', 'mistral'].map(engine => {
    const rows = telemetry.filter(x => x.engine === engine && !x.error);
    const samples = rows.flatMap(row => row.gpu_csv.split('\n').map(line => {
      const [index, uuid, used, total, utilization, watts] = line.split(',').map(x => x.trim());
      return { index: Number(index), used: Number(used), total: Number(total), utilization: Number(utilization), watts: Number(watts),
        engine_mib: row.processes.filter(p => p.engine && p.gpu === uuid).reduce((n, p) => n + p.mib, 0) };
    }));
    return { engine, gpu: [0, 1].map(index => ({ index,
      peak_engine_mib: Math.max(0, ...samples.filter(x => x.index === index).map(x => x.engine_mib)),
      peak_total_mib: Math.max(0, ...samples.filter(x => x.index === index).map(x => x.used)),
      watts: summarize(samples.filter(x => x.index === index), 'watts'),
    })), peak_rss_kib: Math.max(0, ...rows.flatMap(x => x.host ?? []).map(x => x.rss_kib)) };
  });
  const summary = { generated: new Date().toISOString(), state, stats, scores, memory };
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  const text = [
    '# Qwen3.8-Flash-Next: llama.cpp vs mistral.rs', '',
    `Status: **${state.status ?? 'pending'}**. Updated ${summary.generated}.`, '',
    '## Fixed setup', '',
    '- Tower: 2 × NVIDIA RTX A6000; both engines use layer mapping, not tensor parallelism.',
    '- Same Huihui abliterated UD-Q4_K_XL shards and BF16 projector, revision `73e9eb7c69fdbf667def63e233e70845e7d5ac0b`; no requantization.',
    '- llama.cpp b11058; mistral.rs `3f2515e9b5adc2ac44949c128c50a13b15721294`, CUDA 12.8 / SM86 build.',
    '- 32,768-token request context, one active sequence, unquantized FP16 KV, high-reasoning patched native chat template, temperature 0; no speculative decoding.',
    '- Synthetic-only workload runs on the tower against the ClusterIP. Private images, prompts, sessions and inference logs are excluded.',
    '- Forced-length performance requests ignore EOS on both engines. Quality and compatibility tests honor EOS.',
    '- A short mistral.rs preflight (block 0) is excluded from performance statistics. Then two warmups and 30 measured rounds per cell per startup block; three startup blocks per engine, order A1/B1/B2/A2/A3/B3.',
    '- Concurrent-client cells test one-slot queueing, not true multi-sequence batching. Optional tuned batching is not included.', '',
    '## Latency and throughput', '',
    'TTFT includes reasoning. Decode rate excludes prefill and uses `(output_tokens - 1) / (last_token_time - first_token_time)`.',
    'Output counts use server usage where available; otherwise they require a verified `length` finish and the exact forced cap. SSE chunk counts are never treated as token counts.', '',
    '| Cell | llama / mistral attempts | TTFT median ms (A / B) | TTFT p95 ms (A / B) | Decode tok/s (A / B) | Completion median ms (A / B) | Errors (A / B) |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...stats.map(x => `| ${x.cell} | ${x.llama.attempts} / ${x.mistral.attempts} | ${format(x.llama.ttft_ms.median)} / ${format(x.mistral.ttft_ms.median)} | ${format(x.llama.ttft_ms.p95)} / ${format(x.mistral.ttft_ms.p95)} | ${format(x.llama.decode_tps.median)} / ${format(x.mistral.decode_tps.median)} | ${format(x.llama.latency_ms.median)} / ${format(x.mistral.latency_ms.median)} | ${x.llama.errors} / ${x.mistral.errors} |`), '',
    '95% intervals use paired, hierarchical bootstrap resampling by startup block and request. Only three independent startup blocks limits confidence; results are specific to this checkpoint and tower.', '',
    ...stats.filter(x => x.latency_interval).map(x => `- ${x.cell}: completion-latency improvement CI ${x.latency_interval.improvement_pct_ci95.map(n => format(n) + '%').join(' to ')} (${x.latency_interval.pairs} pairs, ${x.latency_interval.blocks} startup blocks).`), '',
    '## Quality and compatibility', '',
    '100 paired objective tasks: 25 arithmetic, 25 retrieval, 25 executable JavaScript tasks with hidden edge cases, and 25 tool/schema tasks. Generated code runs in a non-networked, read-only, unprivileged container with CPU, memory and process limits.', '',
    ...scores.map(x => `- ${x.engine}: ${Object.entries(x.categories).map(([name, score]) => `${name} ${score.passed}/${score.total}`).join('; ')}.`),
    ...compatibility.map(x => `- ${x.engine}, ${x.id}: ${x.passed ? 'PASS' : `FAIL: ${x.error}`}.`), '',
    'This small suite cannot prove less than a two-percentage-point quality loss. No engine change is recommended on speed alone if Codex/Responses/tool compatibility fails.', '',
    '## Memory and power', '',
    ...memory.map(x => `- ${x.engine}: peak engine GPU memory ${x.gpu.map(g => `GPU${g.index} ${format(g.peak_engine_mib / 1024)} GiB`).join(', ')}; peak process RSS ${format(x.peak_rss_kib / 1024 ** 2)} GiB; GPU power medians ${x.gpu.map(g => format(g.watts.median) + ' W').join(', ')}.`), '',
    '[GPU memory chart](memory.svg). Total-device usage also includes unrelated GPU processes, which are not stopped.', '',
    '## Operations and artifacts', '',
    '- Flux switches only the Qwen deployment. Existing H3 remains paused; unrelated GPU processes are untouched.',
    '- The controller restores the baseline deployment in its cleanup path and verifies readiness.',
    '- Raw artifacts: `requests.jsonl`, `telemetry.jsonl`, `startup.jsonl`, `codex-compat.jsonl`, `summary.json`, `state.json`, `model-metadata.json`, and checkpoint hash provenance.',
    '- First visible answer may be absent in forced-length runs that never close reasoning. Only end-to-end quality/compatibility completion should be interpreted as answer responsiveness.',
    ...(state.error ? ['', `Run error: ${state.error}`] : []), '',
    '## Recommendation', '',
    state.status === 'complete' ? 'Evaluate the paired confidence intervals together with all compatibility gates. Keep llama.cpp unless mistral.rs has a meaningful interactive-latency advantage without compatibility or measured quality regression.' : 'Pending: the comparison is not complete, so no speed or quality-equivalence claim is justified.', '',
    '## Sources', '',
    '- [mistral.rs Qwen3.8 implementation and limitations](https://docs.mistralrs.dev/guides/models/model-family-notes/#qwen38-flash-next)',
    '- [mistral.rs layer mapping](https://docs.mistralrs.dev/guides/perf/distributed-inference/)',
    '- [Codex app-server compaction lifecycle](https://learn.chatgpt.com/docs/app-server)', '',
  ].join('\n');
  await writeFile(`${dir}/report.md`, text);
  const bars = memory.flatMap((row, i) => row.gpu.map((gpu, j) => {
    const y = 58 + (i * 2 + j) * 48, width = gpu.peak_engine_mib / 49140 * 440;
    return `<text x="12" y="${y + 18}">${row.engine} GPU${j}</text><rect x="140" y="${y}" width="${width}" height="25" fill="${i ? '#d97706' : '#2563eb'}"/><text x="${150 + width}" y="${y + 18}">${format(gpu.peak_engine_mib / 1024)} GiB</text>`;
  })).join('');
  await writeFile(`${dir}/memory.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="740" height="270" viewBox="0 0 740 270"><rect width="740" height="270" fill="white"/><g font-family="sans-serif" font-size="14" fill="#111"><text x="12" y="28">Peak engine GPU memory (48 GiB per GPU)</text>${bars}</g></svg>\n`);
  return summary;
}

if (process.argv[1]?.endsWith('/report.mjs')) await generateReport(resolve(process.argv[2] ?? '.'));
