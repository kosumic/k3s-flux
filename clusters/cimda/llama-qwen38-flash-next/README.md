# Qwen3.8 Flash Next on the tower

This Flux-managed llama.cpp service runs on both NVIDIA RTX A6000 GPUs on
`cimda0728-tower`. MiniMax-H3 remains paused while this service owns both GPUs.

## Active model

- Repository: `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF`.
- Pinned revision: `73e9eb7c69fdbf667def63e233e70845e7d5ac0b`.
- Quantization: `UD-Q4_K_XL`; four GGUF shards plus the matching BF16 vision projector.
- Container path: `/models/abliterated-huihui/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf`.
- Download job: `qwen38-flash-next-abliterated-download` in namespace `llama-qwen38`.
  It uses `uvx` and verifies all five downloaded files against pinned SHA-256 hashes.
  The server waits for the verification marker before loading the weights.

The legacy API model ID `qwen3.8-flash-next-ud-iq3-xxs` is retained for local
Codex compatibility. It now identifies the abliterated Q4 checkpoint; the
deployment annotations and `/props` show the actual repository and model path.

This is a community abliterated checkpoint, not an official Qwen release.
Reduced refusals do not guarantee unrestricted behavior or unchanged reasoning
and coding quality; no comprehensive quality benchmark was performed here.

## Runtime and endpoints

The pinned llama.cpp image is `server-cuda12-b11058`, with its digest recorded
in `deployment.yaml`. The service uses a 32,768-token context, one request slot,
all transformer layers on the GPUs, layer splitting `1,1`, Flash Attention,
and the compatibility-patched model Jinja template. `per_layer_token_embd=CPU` keeps the large
n-gram lookup table in CPU RAM. Lazy loading is disabled.

- Cluster service: `llama-qwen38-flash-next.llama-qwen38.svc:8080`.
- Current service IP: `10.43.162.181:8080`.
- Direct Codex endpoint: `http://100.100.130.75/qwen/v1` over Tailscale HTTP.
  Flux-managed Traefik Ingress strips `/qwen` before forwarding to llama.cpp.
  Its IPAllowList permits tailnet and loopback peers; LAN clients are rejected.
- The old `codex-qwen38-tunnel.service` is no longer needed. It can be restored
  as a fallback by enabling it and reverting the Codex provider base URL to
  `http://127.0.0.1:18081/v1`.
- Both `/v1/chat/completions` and `/v1/responses` are served by llama.cpp.

On the tower itself, the cluster Service IP remains usable directly. A pod's
port is not automatically bound to host `localhost`; use the cluster Service
for local diagnostics. From the workstation, launch the configured profile:

```sh
codex --profile qwen38-flash-next
```

## Codex compaction compatibility

`chat-template.jinja` is a copy of the active pinned checkpoint's embedded
template, with one compatibility change: late `system` or `developer` messages
are rendered as system messages at their original history position instead
of raising `System message must be at the beginning.` This preserves both
instruction priority and chronology; it does not hoist later instructions to
the start or relabel them as user messages.

The original embedded template's SHA-256 is
`12827f24b742ea4e80cdc12dbcf9622227056b9f797252a3149263d4f9aaadce`.
Before rollout, 12 synthetic CPU rendering comparisons confirmed byte-identical
ordinary text, vision/video placeholders, tool history, and reasoning history
at low, medium, and high effort. Actual image/video inference and comprehensive
quality benchmarks are not covered by these compatibility checks.

Codex retains older user messages and reinjects developer context immediately
before the latest user message after local compaction. The original template
rejects that ordering with HTTP 500, which Codex misleadingly presents as
`We're currently experiencing high demand`.

Kustomize generates a content-hashed ConfigMap from the template, mounts it
read-only at `/etc/llama`, and passes `--chat-template-file` to llama.cpp.
Template edits therefore trigger a normal Flux-managed Deployment rollout;
there are no manual live patches. Keep the template tied to this checkpoint
and compare it against a new model's native template before changing weights.

All other native rendering, including tool calls, vision/video placeholders,
and thinking format, is unchanged. The workstation Qwen profile defaults to
`model_reasoning_effort = "high"`; this checkpoint's template maps `high` to
its native `xhigh` reasoning instruction. This is model-template behavior,
not a promise of OpenAI-equivalent reasoning budgets. Existing Codex sessions
may retain their previous effort; select high in `/model` or restart with the
profile. The plain `codex` model selection is not changed.

Run the synthetic integration regression from this directory:

```sh
node verify-codex.mjs
# For another deployment:
QWEN_TEST_BASE=http://100.100.130.75/qwen node verify-codex.mjs
```

The check validates the mounted template, late developer messages at low/high
effort, high-effort function-call round trips, streaming, and message ordering.
It never reads user sessions, prompts, uploaded images, or server logs.
Rollback by reverting the compatibility commit in Git and reconciling Flux;
removing the generated ConfigMap, volume, mount, and template-file arguments
restores the checkpoint's embedded template. No weight download is needed.

## Original model and rollback

The original `unsloth/Qwen3.8-Flash-Next-GGUF` IQ3 checkpoint remains on the
same PVC, pinned to `38bb39ee97821de2c9009abb7e93950eec396e66`. Its download job
and verification marker are retained.

To roll back through Flux, revert the model-switch commit and push it to
`main`. Alternatively, restore these deployment values and commit/push:

- Model: `/models/UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf`.
- Projector: `/models/mmproj-BF16.gguf`.
- Verification marker: `/models/.verified-38bb39ee97821de2c9009abb7e93950eec396e66`.
- Remove or update the model annotations to match the restored checkpoint.

Keep changes in Git; avoid patching the live Deployment outside Flux.

## Checks

Verified on 2026-10-02 after activation:

- All four GGUF shards and the vision projector passed pinned SHA-256 checks.
- Deployment became Ready with no restarts; both RTX A6000s were in use.
  GPU memory immediately after loading was 42,826 MiB and 41,049 MiB.
- `/props` through the local tunnel identified the abliterated Q4 model path.
- Synthetic arithmetic passed through Chat Completions and Responses at low
  and high reasoning effort. Responses function calling and SSE streaming
  also passed. These are compatibility smoke tests, not quality benchmarks.
- After the HTTP ingress migration, all of those API smoke tests passed again
  at `http://100.100.130.75/qwen`. The old SSH tunnel was stopped and disabled,
  and the direct HTTP health endpoint remained healthy.
- Non-tailnet source-IP requests returned 403 on both HTTP port 80 and the
  allocated NodePort. Spoofing X-Forwarded-For did not bypass the allowlist.

Rollback of the HTTP migration does not require changing the model. Enable
the existing tunnel with `systemctl --user enable --now codex-qwen38-tunnel.service`
and restore `model_providers.qwen38_tower.base_url` in the workstation's
`~/.codex/config.toml` to `http://127.0.0.1:18081/v1`. To remove the route,
remove its Ingress and middleware resources from the Flux app overlay and
commit/push; do not delete the live objects outside Flux.

The switch is commit `881532b0cbcb1038b0279d7a5203e8bed4b35d0c`; reverting
that commit restores the original deployment settings.

From the Flux repository:

```sh
kubectl kustomize clusters/cimda/llama-qwen38-flash-next
ssh cimda0728@cimda0728-tower \
  'kubectl -n llama-qwen38 get jobs,pods,svc'
ssh cimda0728@cimda0728-tower \
  'kubectl -n llama-qwen38 rollout status deployment/llama-qwen38-flash-next'
curl --fail http://100.100.130.75/qwen/health
curl --fail http://100.100.130.75/qwen/props
```

Use synthetic test prompts for verification; do not inspect user-uploaded
reference images, ComfyUI prompts, or model request logs.
