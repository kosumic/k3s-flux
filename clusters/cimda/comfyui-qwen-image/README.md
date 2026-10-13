# Qwen Image 2.1 in ComfyUI

Flux deploys one ComfyUI replica on the CIMDA tower, requesting one RTX A6000.
Open http://cimda0728-tower/comfyui/ or http://100.100.130.75/comfyui/ from
Tailscale. The ingress keeps the existing tailnet-only policy.

Open the Workflows sidebar and select Qwen Image 2.1 Turbo for an 8-step
generation, or Qwen Image 2.1 for the standard 25-step preset. Edit the prompt
in Text Encode Qwen Image 2.1 and click Run. Both presets start at 1024 x 1024.
Increase the Image size node for larger images. The official model also supports
image editing through reference images on Text Encode Qwen Image 2.1.

## Versions and model files

- ComfyUI: 06c67806bcb36789a1e8e1278c6a764b389ff858.
- PyTorch: 2.10.0 with CUDA 12.8; torchvision: 0.25.0.
- Model repository: https://huggingface.co/Comfy-Org/Qwen-Image-2.1
- Model revision: df94239739eef7205973a145ffa6f441f7b64e84.
- Generator: qwen_image_2.1_bf16.safetensors (14.2 GB).
- Text encoder: qwen3vl_8b_int8_convrot.safetensors (9.4 GB).
- VAE: qwen_image_2.1_vae_bf16.safetensors (676 MB).
- Turbo: official qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors (913 MB).

The download Job verifies every file against the upstream SHA-256 hashes.
The runtime init container installs ComfyUI and CUDA wheels once into persistent
storage and records exact dependency versions in runtime/requirements-resolved.txt.
Partner API nodes are disabled; generation runs locally.
The model uses the Qwen Research License from the upstream model repository.

## Storage

All app data is stored in /home/data2/zelinrick/nautilus/comfyui-qwen-image:

- models: downloaded model files.
- runtime: pinned ComfyUI checkout and Python environment.
- user/default/workflows: the two starter workflows and saved workflows.
- input and output: uploaded and generated images.
- cache: Hugging Face and uv downloads.

The local PersistentVolume is pinned to cimda0728-tower and uses Retain.
Its declared capacity is 150 GiB; local volumes do not enforce a disk quota.
Create the directory owned by UID/GID 1000 before deploying on a fresh node.
Bootstrap preserves existing starter workflows so user edits survive restarts.

## Validation and operations

Run on CIMDA from the k3s-flux checkout:

    kubectl kustomize clusters/cimda/comfyui-qwen-image | kubectl apply --dry-run=client -f -
    kubectl kustomize clusters/cimda | kubectl apply --dry-run=client -f -
    kubectl -n comfyui-qwen-image get pods,pvc,job
    kubectl -n comfyui-qwen-image logs deployment/comfyui-qwen-image -c comfyui
    source /home/cimda0728/.local/bin/env
    UV_CACHE_DIR=/home/data2/zelinrick/nautilus/uv-cache uv run --no-project --python 3.12 python clusters/cimda/comfyui-qwen-image/verify-generation.py

Pass --standard to verify the standard preset. The check submits a real image
generation and verifies the returned PNG and dimensions.

To release the GPU, change replicas to 0 in deployment.yaml, commit, and push.
Flux will scale the deployment down while retaining models and generated images.
