import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReport } from './report.mjs';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const scripts = resolve(repo, 'benchmarks/qwen38-engines');
const output = resolve(process.env.BENCH_LOCAL_DIR ?? '/home/kosumi/repos/comfyUI/benchmark-results/full');
const remote = '/home/cimda0728/qwen-engine-benchmark-20261004';
const remoteFull = `${remote}/full`;
const host = 'cimda0728@fd7a:115c:a1e0::a532:824d';
const scpHost = 'cimda0728@[fd7a:115c:a1e0::a532:824d]';
const sshOptions = ['-6', '-o', 'HostKeyAlias=cimda0728-tower', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'IPQoS=none', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
const app = 'clusters/cimda/llama-qwen38-flash-next';
const kust = `${repo}/${app}/kustomization.yaml`;
const gitSsh = 'ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopped = false, mutation = false;
const children = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopped = true;
  for (const child of children) child.kill('SIGTERM');
});
async function run(command, args, { timeout = 60_000, input, quiet = false, cwd = repo, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; if (!quiet) process.stdout.write(data); });
    child.stderr.on('data', data => { stderr += data; if (!quiet) process.stderr.write(data); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      children.delete(child); clearTimeout(timer);
      if (code === 0) resolve(stdout); else reject(new Error(`${command} exited ${code}/${signal}: ${stderr.slice(-2000)}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
const ssh = (command, options) => run('ssh', [...sshOptions, host, command], options);
const git = (...args) => run('git', ['-c', `core.sshCommand=${gitSsh}`, ...args]);
async function state(status, more = {}) {
  await writeFile(`${output}/state.json`, JSON.stringify({ status, updated: new Date().toISOString(), ...more }, null, 2) + '\n');
  await generateReport(output);
}
async function reconcile(revision, restoring = false) {
  await ssh('kubectl -n flux-system annotate gitrepository flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)" --overwrite');
  for (let attempt = 0; attempt < 300; attempt++) {
    if (stopped && !restoring) throw new Error('Benchmark cancelled; restoring baseline');
    const source = JSON.parse(await ssh('kubectl -n flux-system get gitrepository flux-system -o json', { quiet: true }));
    if (source.status?.artifact?.revision === `main@sha1:${revision}`) break;
    if (attempt === 299) throw new Error('Flux source reconciliation timed out');
    await sleep(4000);
  }
  await ssh('kubectl -n flux-system annotate kustomization flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)" --overwrite');
  for (let attempt = 0; attempt < 450; attempt++) {
    if (stopped && !restoring) throw new Error('Benchmark cancelled; restoring baseline');
    const flux = JSON.parse(await ssh('kubectl -n flux-system get kustomization flux-system -o json', { quiet: true }));
    const deployment = JSON.parse(await ssh('kubectl -n llama-qwen38 get deployment llama-qwen38-flash-next -o json', { quiet: true }));
    if (flux.status?.lastAppliedRevision === `main@sha1:${revision}` && deployment.status?.observedGeneration === deployment.metadata.generation && deployment.status?.readyReplicas === 1) return;
    if (attempt === 449) throw new Error('Deployment readiness timed out');
    await sleep(4000);
  }
}
async function publish(message, restoring = false) {
  const rendered = await run('kubectl', ['kustomize', app], { quiet: true });
  const deployment = rendered.split(/^---$/m).find(text => /^kind: Deployment$/m.test(text));
  assert.ok(deployment, 'Missing rendered deployment');
  // Existing Jobs carry API-generated immutable labels; validate only the changed workload.
  await ssh('kubectl apply --server-side --field-manager=kustomize-controller --dry-run=server -f -', { input: deployment, quiet: true });
  await git('add', `${app}/kustomization.yaml`);
  if ((await git('status', '--porcelain', `${app}/kustomization.yaml`)).trim()) await git('commit', '-m', message);
  await git('push', 'origin', 'main');
  const revision = (await git('rev-parse', 'HEAD')).trim();
  await reconcile(revision, restoring);
  return revision;
}
async function collect() {
  await run('scp', [...sshOptions, `${scpHost}:${remoteFull}/requests.jsonl`, `${scpHost}:${remoteFull}/telemetry.jsonl`, output], { timeout: 180_000 });
  await generateReport(output);
}
await mkdir(output, { recursive: true });
const original = await readFile(kust, 'utf8');
let managed = original;
async function changeOverlay(content) {
  assert.equal(await readFile(kust, 'utf8'), managed, 'App overlay changed outside the benchmark; preserve user edits and recover manually');
  await writeFile(kust, content);
  managed = content;
}
assert.ok(!original.includes('benchmark-mistralrs\n'), 'Already switched; restore the previous controller baseline before starting another run');
const dirty = (await git('status', '--porcelain')).trim();
assert.equal(dirty, '', 'Commit benchmark infrastructure first; do not overwrite unrelated worktree changes');
await writeFile(`${output}/baseline-kustomization.yaml`, original);
await writeFile(`${output}/baseline-revision.txt`, (await git('rev-parse', 'HEAD')).trim() + '\n');
try {
  await state('waiting_for_build');
  while (true) {
    if (stopped) throw new Error('Cancelled before build completed');
    const job = JSON.parse(await ssh('kubectl -n llama-qwen38 get job qwen38-mistralrs-build-3f2515e9 -o json', { quiet: true }));
    if (job.status?.succeeded === 1) break;
    if (job.status?.conditions?.some(x => x.type === 'Failed' && x.status === 'True')) throw new Error('Pinned mistral.rs CUDA build failed; baseline was not interrupted');
    await sleep(20_000);
  }
  await run('scp', [...sshOptions, `${scripts}/bench.mjs`, `${scpHost}:${remote}/`]);
  await ssh(`node -e ${quote(`const fs=require('fs');fs.mkdirSync('${remoteFull}',{recursive:true});fs.copyFileSync('${remote}/fixtures.json','${remoteFull}/fixtures.json');fs.copyFileSync('${remote}/fixtures.sha256','${remoteFull}/fixtures.sha256');`)}`);
  await run('scp', [...sshOptions, `${scpHost}:${remote}/model-metadata.json`, `${scpHost}:${remote}/fixtures.sha256`, output]);
  for (const [engine, block] of [['mistral', 0], ['llama', 1], ['mistral', 1], ['mistral', 2], ['llama', 2], ['llama', 3], ['mistral', 3]]) {
    if (stopped) throw new Error('Benchmark cancelled');
    await state('switching', { engine, block });
    // Generated Kustomize switches are committed, validated and reconciled through Flux.
    const nonce = `${engine}-${block}-${Date.now()}`;
    const switchText = original + (engine === 'mistral' ? '\ncomponents:\n  - benchmark-mistralrs\n' : '') +
      '\npatches:\n  - target:\n      kind: Deployment\n      name: llama-qwen38-flash-next\n      namespace: llama-qwen38\n    patch: |-\n' +
      '      - op: add\n        path: /spec/template/metadata/annotations/benchmark-run\n' + `        value: ${nonce}\n`;
    mutation = true;
    await changeOverlay(switchText);
    const started = new Date();
    const monitorEnv = `BENCH_DIR=${quote(remoteFull)} BENCH_ENGINE=${engine} BENCH_BLOCK=${block}`;
    const monitor = ssh(`cd ${quote(remote)} && ${monitorEnv} node bench.mjs monitor`, { timeout: 3_600_000, quiet: true }).catch(error => console.warn(`Startup monitor: ${error.message}`));
    let revision;
    try { revision = await publish(`chore: benchmark ${engine} startup block ${block}`); }
    finally {
      await ssh(`node -e ${quote(`require('fs').writeFileSync('${remoteFull}/stop-monitor-${engine}-${block}', 'stop')`)}`).catch(error => console.warn(error.message));
      await monitor;
    }
    const ready = new Date();
    const pods = JSON.parse(await ssh('kubectl -n llama-qwen38 get pods -l app=llama-qwen38-flash-next -o json', { quiet: true }));
    const pod = pods.items.find(x => x.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
    assert.ok(pod);
    const container = pod.status.containerStatuses?.[0];
    await appendFile(`${output}/startup.jsonl`, JSON.stringify({ engine, block, revision, started, ready,
      rollout_to_ready_ms: ready - started, container_to_ready_ms: ready - new Date(container.state.running.startedAt),
      pod: pod.metadata.name, image: container.imageID }) + '\n');
    await run('kubectl', ['kustomize', app], { quiet: true }).then(text => writeFile(`${output}/deployment-${engine}-${block}.yaml`, text));
    await state('running', { engine, block });
    const env = `BENCH_DIR=${quote(remoteFull)} BENCH_ENGINE=${engine} BENCH_BLOCK=${block}`;
    if (block === 0) {
      await ssh(`cd ${quote(remote)} && ${env} BENCH_REPEATS=2 BENCH_WARMUPS=1 BENCH_CELLS=prefill-512,prefill-8192,decode-512 node bench.mjs perf`, { timeout: 1_800_000 });
    }
    await ssh(`cd ${quote(remote)} && ${env} node bench.mjs compat`, { timeout: 900_000 });
    await run('node', [`${scripts}/codex-compat.mjs`], { timeout: 700_000, cwd: repo,
      env: { BENCH_DIR: output, BENCH_ENGINE: engine, BENCH_BLOCK: String(block) },
    }).catch(error => console.warn(`Codex compatibility failed and was recorded: ${error.message}`));
    if (block > 0) await ssh(`cd ${quote(remote)} && ${env} node bench.mjs perf`, { timeout: 28_800_000 });
    if (block === 1) await ssh(`cd ${quote(remote)} && ${env} node bench.mjs quality`, { timeout: 14_400_000 });
    await collect();
    await state('block_complete', { engine, block });
  }
  await state('restoring');
  await changeOverlay(original);
  await publish('chore: restore llama.cpp after paired engine benchmark', true);
  mutation = false;
  await state('complete', { baseline_restored: true });
} catch (error) {
  console.error(error.stack);
  if (mutation) await collect().catch(error => console.warn(`Partial artifacts: ${error.message}`));
  await state('failed', { error: error.message, baseline_restored: !mutation });
  process.exitCode = 1;
} finally {
  if (mutation) {
    try {
      await changeOverlay(original);
      await publish('fix: restore llama.cpp after interrupted engine benchmark', true);
      mutation = false;
      const prior = JSON.parse(await readFile(`${output}/state.json`, 'utf8'));
      await state(prior.status, { ...prior, baseline_restored: true });
    } catch (error) {
      await state('restore_failed', { error: error.message, baseline_restored: false });
      console.error('CRITICAL: automatic Flux restoration failed', error);
    }
  }
}
