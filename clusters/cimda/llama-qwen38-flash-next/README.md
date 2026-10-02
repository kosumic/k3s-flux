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

## Runtime and endpoints

The pinned llama.cpp image is `server-cuda12-b11058`, with its digest recorded
in `deployment.yaml`. The service uses a 32,768-token context, one request slot,
all transformer layers on the GPUs, layer splitting `1,1`, Flash Attention,
and the model's Jinja template. `per_layer_token_embd=CPU` keeps the large
n-gram lookup table in CPU RAM. Lazy loading is disabled.

- Cluster service: `llama-qwen38-flash-next.llama-qwen38.svc:8080`.
- Current service IP: `10.43.162.181:8080`.
- Local Codex endpoint: `http://127.0.0.1:18081/v1` through the existing
  `codex-qwen38-tunnel.service` SSH tunnel over Tailscale.
- Both `/v1/chat/completions` and `/v1/responses` are served by llama.cpp.

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

From the Flux repository:

```sh
kubectl kustomize clusters/cimda/llama-qwen38-flash-next
ssh cimda0728@cimda0728-tower \
  'kubectl -n llama-qwen38 get jobs,pods,svc'
ssh cimda0728@cimda0728-tower \
  'kubectl -n llama-qwen38 rollout status deployment/llama-qwen38-flash-next'
curl --fail http://127.0.0.1:18081/health
curl --fail http://127.0.0.1:18081/props
```

Use synthetic test prompts for verification; do not inspect user-uploaded
reference images, ComfyUI prompts, or model request logs.
