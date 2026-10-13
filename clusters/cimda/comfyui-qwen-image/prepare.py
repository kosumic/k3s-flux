import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

REVISION = "06c67806bcb36789a1e8e1278c6a764b389ff858"
DATA = Path(os.environ.get("COMFY_DATA_DIR", "/data"))
CONFIG = Path(__file__).parent
RUNTIME = DATA / "runtime"
SOURCE = RUNTIME / f"ComfyUI-{REVISION}"
VENV = RUNTIME / "venv"
for directory in ("runtime", "models", "custom_nodes", "input", "output", "temp", "cache", "user/default/workflows"):
    (DATA / directory).mkdir(parents=True, exist_ok=True)
os.environ["UV_CACHE_DIR"] = str(DATA / "cache/uv")
os.environ["HF_HOME"] = str(DATA / "cache/huggingface")
identity = hashlib.sha256(Path(__file__).read_bytes() + (CONFIG / "constraints.txt").read_bytes()).hexdigest()
marker = RUNTIME / f".ready-{identity}"
if not marker.exists():
    if not SOURCE.exists():
        archive = RUNTIME / "comfyui.tar.gz"
        urllib.request.urlretrieve(f"https://codeload.github.com/Comfy-Org/ComfyUI/tar.gz/{REVISION}", archive)
        with tarfile.open(archive) as bundle:
            bundle.extractall(RUNTIME, filter="data")
        archive.unlink()
    if not (VENV / "pyvenv.cfg").exists():
        subprocess.run(["uv", "venv", "--python", sys.executable, str(VENV)], check=True)
    subprocess.run([
        "uv", "pip", "install", "--python", str(VENV / "bin/python"),
        "--index-url", "https://download.pytorch.org/whl/cu128",
        "torch==2.10.0", "torchvision==0.25.0",
    ], check=True)
    subprocess.run([
        "uv", "pip", "install", "--python", str(VENV / "bin/python"),
        "-r", str(SOURCE / "requirements.txt"), "-c", str(CONFIG / "constraints.txt"),
    ], check=True)
    lock = subprocess.run(["uv", "pip", "freeze", "--python", str(VENV / "bin/python")], check=True, capture_output=True, text=True)
    (RUNTIME / "requirements-resolved.txt").write_text(lock.stdout)
    marker.touch()
for source_name, name in (("qwen-image-2.1.json", "Qwen Image 2.1.json"), ("qwen-image-2.1-turbo.json", "Qwen Image 2.1 Turbo.json")):
    target = DATA / "user/default/workflows" / name
    if not target.exists():
        shutil.copyfile(CONFIG / source_name, target)
print(f"ComfyUI runtime ready at {SOURCE}", flush=True)
