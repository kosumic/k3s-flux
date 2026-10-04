# Qwen engine benchmark

Compares the deployed Huihui Qwen3.8-Flash-Next UD-Q4_K_XL GGUF on llama.cpp
b11058 and mistral.rs `3f2515e9b5adc2ac44949c128c50a13b15721294` using both A6000s.
The native API alias contains `iq3` for historical compatibility; the actual
checkpoint is Q4. Never switch quantization when comparing the engines.

The source build is a CPU-only Flux Job. It does not interrupt llama.cpp. Its
80 GiB build PVC stores Rust/CUDA artifacts separately from the model PVC.
The mistral.rs runtime uses the exact pulled CUDA image digest and the built
binary. The default app overlay remains llama.cpp; the mistral.rs component is
inactive except during controlled benchmark blocks.

## Test and validate

```sh
node --test benchmarks/qwen38-engines/bench.test.mjs
node --test benchmarks/qwen38-engines/report.test.mjs
node --check benchmarks/qwen38-engines/controller.mjs
bash -n clusters/cimda/llama-qwen38-flash-next/benchmark-build.sh
kubectl kustomize benchmarks/qwen38-engines/preview
```

The preview is for rendering/server dry-run only. Do not apply it directly;
all real switches must be committed and reconciled through Flux.

## Run

The tower-side scripts use Node 18+ and only generated fixture files. Copy
`bench.mjs` and `inspect-model.mjs` to a new benchmark-owned directory on the
tower, then run `node inspect-model.mjs` and `node bench.mjs prepare` while the
baseline is running. Never enumerate user input directories or saved Codex
threads. The historical `/home/data2/zelinrick/comfy` path was absent during
this run, so the isolated working directory is:

`/home/cimda0728/qwen-engine-benchmark-20261004`

The local controller defaults to that tower directory and writes its collected
artifacts into `/home/kosumi/repos/comfyUI/benchmark-results/full`.
Start only from a clean, pushed worktree:

```sh
node benchmarks/qwen38-engines/controller.mjs
```

The controller waits for the build, then runs A1/B1/B2/A2/A3/B3. Each block
contains two warmups and 30 measured rounds in 12 performance cells. Quality
uses 100 paired tasks once per engine. Compatibility runs in every block,
including an isolated real Codex app-server compaction test over the public
tailnet endpoint. Forced-length microbenchmarks run directly on the tower,
excluding Tailscale latency. Performance, quality and compatibility run
sequentially, not concurrently.

The controller commits/reconciles temporary switches, snapshots rendered
deployments, collects per-request and per-GPU telemetry, generates a report,
and restores the exact baseline overlay on completion or failure. SIGINT and
SIGTERM trigger its restoration path; do not use SIGKILL. Give a service
manager sufficient stop timeout for a model reload. No restart policy is used,
because blindly restarting could capture a switched overlay as the baseline.

Failures are retained. A model-load or tokenizer mismatch stops the current
block and restores llama.cpp. Compatibility failures are scored and do not
silently disappear from the speed report. Never stop unrelated GPU processes.

Generated JavaScript is tested in a pinned, unprivileged Docker container on
the tower with no network, host mounts, GPU devices or capabilities, a
read-only root, and CPU/memory/process/time limits. The local workstation
does not require Docker.

## Interpret

Single-slot queued concurrency is not continuous batching. A future tuned
batching comparison must preserve 32K per-sequence context and equal total KV
capacity; it is not part of this baseline run. CUDA graphs may be disabled in
mistral.rs when the exact GGUF PLE table falls back to host gathers; record
this instead of changing weights to make the result look faster.

Decode rate excludes prefill and counts reasoning tokens. An SSE chunk is not
a token. Where mistral.rs streaming lacks usage, only an exact forced output
cap with a verified `length` finish supplies the count. Non-streaming
calibration verifies the native tokenizer's prompt count for every input size.
Both engines ignore EOS only for these performance microbenchmarks.

The report uses block/request paired bootstrap intervals; three startup
blocks and 100 quality tasks provide limited confidence. They do not establish
less than two percentage points of quality loss. Prefer llama.cpp unless
mistral.rs demonstrates a useful interactive-latency advantage and passes the
Codex/Responses/tools gates without a material observed quality regression.

## Recovery

`baseline-kustomization.yaml` in the local results directory is the exact
pre-run overlay. If automatic restoration fails, restore only the app's
`kustomization.yaml` from that benchmark-owned snapshot, inspect the diff,
commit/push, and reconcile the Flux source and kustomization. Do not reset the
repository or use `kubectl apply` as a substitute for GitOps.

## Git commands

```sh
git add benchmarks/qwen38-engines clusters/cimda/llama-qwen38-flash-next/benchmark-build.sh clusters/cimda/llama-qwen38-flash-next/benchmark-build-pvc.yaml clusters/cimda/llama-qwen38-flash-next/benchmark-build-job.yaml clusters/cimda/llama-qwen38-flash-next/benchmark-mistralrs clusters/cimda/llama-qwen38-flash-next/kustomization.yaml
git cm "chore: add reproducible paired Qwen engine benchmark"
```
