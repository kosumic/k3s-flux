import argparse
import json
import struct
import time
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://100.100.130.75/comfyui")
parser.add_argument("--size", type=int, default=1024)
parser.add_argument("--standard", action="store_true")
parser.add_argument("--output", type=Path)
args = parser.parse_args()
url = args.url.rstrip("/")
def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{error.code}: {error.read().decode()}") from error

stats = json.loads(request("/system_stats"))
print(json.dumps({"devices": stats["devices"]}), flush=True)
workflow_name = "Qwen Image 2.1.json" if args.standard else "Qwen Image 2.1 Turbo.json"
workflow = json.loads((Path(__file__).parent / workflow_name).read_text())
for node in workflow["nodes"]:
    if node["type"] == "EmptyLatentImage":
        node["widgets_values"][:2] = [args.size, args.size]
prompt = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_bf16.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image", "device": "default"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
    "4": {"class_type": "TextEncodeQwenImage21", "inputs": {
        "clip": ["2", 0], "vae": ["3", 0], "resolution": args.size,
        "prompt": 'A cinematic photograph of Hong Kong harbour at sunrise. Warm sunlight falls across the water, ferries, and skyline. A clean sign in the foreground reads "CIMDA".',
        "negative_prompt": ""}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": args.size, "height": args.size, "batch_size": 1}},
    "6": {"class_type": "KSampler", "inputs": {
        "model": ["1" if args.standard else "9", 0], "positive": ["4", 0], "negative": ["4", 1],
        "latent_image": ["5", 0], "seed": 42, "steps": 25 if args.standard else 8,
        "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
    "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
    "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "deployment_test_standard" if args.standard else "deployment_test_turbo"}},
}
if not args.standard:
    prompt["9"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
        "model": ["1", 0], "lora_name": "qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors", "strength_model": 1.0}}
started = time.monotonic()
queued = json.loads(request("/prompt", {"prompt": prompt, "extra_data": {"extra_pnginfo": {"workflow": workflow}}}))
if queued.get("node_errors"):
    raise RuntimeError(queued["node_errors"])
ident = queued["prompt_id"]
print(json.dumps({"prompt_id": ident, "size": args.size, "steps": 25 if args.standard else 8}), flush=True)
deadline = started + 1800
while time.monotonic() < deadline:
    entry = json.loads(request("/history/" + ident)).get(ident)
    if entry is not None:
        if entry["status"]["status_str"] != "success":
            raise RuntimeError(json.dumps(entry["status"]))
        image = entry["outputs"]["8"]["images"][0]
        content = request("/view?" + urllib.parse.urlencode(image))
        if content[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError("Generated output is not a PNG")
        width, height = struct.unpack(">II", content[16:24])
        if (width, height) != (args.size, args.size):
            raise RuntimeError(f"Unexpected image dimensions: {width} x {height}")
        if args.output:
            args.output.write_bytes(content)
        print(json.dumps({"success": True, "image": image, "width": width, "height": height,
                          "bytes": len(content), "elapsed_seconds": round(time.monotonic() - started, 1)}), flush=True)
        break
    time.sleep(5)
else:
    raise TimeoutError(f"Generation {ident} did not finish within 30 minutes")
