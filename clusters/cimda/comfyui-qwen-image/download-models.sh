#!/bin/sh
set -eu
data="${COMFY_DATA_DIR:-/data}"
revision=df94239739eef7205973a145ffa6f441f7b64e84
mkdir -p "$data/models"
if test -f "$data/models/.verified-$revision"; then
  exit 0
fi
export HF_HOME="$data/cache/huggingface"
export HF_HUB_DOWNLOAD_TIMEOUT=600
export UV_CACHE_DIR="$data/cache/uv"
uvx --from 'huggingface_hub[hf_xet]==0.35.3' hf download \
  Comfy-Org/Qwen-Image-2.1 \
  diffusion_models/qwen_image_2.1_bf16.safetensors \
  text_encoders/qwen3vl_8b_int8_convrot.safetensors \
  vae/qwen_image_2.1_vae_bf16.safetensors \
  loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors \
  --revision "$revision" --local-dir "$data/models"
cd "$data/models"
sha256sum -c - <<'HASHES'
89f4158d066cc33906a199fca85634f766892dd78f49b6698dabf187ac86c4bc  diffusion_models/qwen_image_2.1_bf16.safetensors
8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f  text_encoders/qwen3vl_8b_int8_convrot.safetensors
bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9  vae/qwen_image_2.1_vae_bf16.safetensors
208dd43250e1e01467ba190572ae2e7107a7870ec1ff026bc65f791fa1e80e95  loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors
HASHES
touch ".verified-$revision"
