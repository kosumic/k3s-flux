#!/usr/bin/env python3
"""Loopback-only NVIDIA telemetry for Prometheus; no CUDA context is created."""
import argparse
import csv
import io
import json
import math
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FIELDS = "index,uuid,name,utilization.gpu,memory.used,memory.total,memory.free,temperature.gpu,power.draw"
METRICS = (
    ("nvidia_gpu_utilization_percent", "GPU utilization (percent).", 3, 1, True),
    ("nvidia_gpu_memory_used_bytes", "Allocated framebuffer memory (bytes).", 4, 1048576, True),
    ("nvidia_gpu_memory_total_bytes", "Total framebuffer capacity (bytes).", 5, 1048576, True),
    ("nvidia_gpu_memory_free_bytes", "Free framebuffer memory (bytes).", 6, 1048576, True),
    ("nvidia_gpu_temperature_celsius", "GPU temperature (Celsius).", 7, 1, False),
    ("nvidia_gpu_power_watts", "GPU power draw (watts).", 8, 1, False),
)


def render_metrics(output):
    rows = list(csv.reader(io.StringIO(output), skipinitialspace=True))
    if not rows:
        raise ValueError("nvidia-smi returned no GPUs")
    samples = {name: [] for name, *_ in METRICS}
    seen = set()
    for row in rows:
        if len(row) != 9:
            raise ValueError("unexpected nvidia-smi column count")
        gpu, uuid, model = [value.strip() for value in row[:3]]
        if not gpu.isdigit() or not uuid.startswith("GPU-") or uuid in seen:
            raise ValueError("invalid or duplicate physical GPU identity")
        seen.add(uuid)
        labels = ",".join(f"{key}={json.dumps(value, ensure_ascii=True)}"
                          for key, value in (("gpu", gpu), ("uuid", uuid), ("model", model)))
        for name, _, column, scale, required in METRICS:
            try:
                value = float(row[column].strip())
                if not math.isfinite(value) or value < 0:
                    raise ValueError("invalid value")
                if column == 3 and value > 100:
                    raise ValueError("utilization above 100 percent")
            except ValueError:
                if required:
                    raise ValueError(f"unavailable required metric: {name}") from None
                continue
            samples[name].append(f"{name}{{{labels}}} {value * scale:.17g}")
    lines = []
    for name, description, *_ in METRICS:
        lines.extend((f"# HELP {name} {description}", f"# TYPE {name} gauge"))
        lines.extend(samples[name])
    return "\n".join(lines) + "\n"


def collect():
    result = subprocess.run(
        ["/usr/bin/nvidia-smi", f"--query-gpu={FIELDS}", "--format=csv,noheader,nounits"],
        check=True, text=True, capture_output=True, timeout=5,
    )
    return render_metrics(result.stdout)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/metrics", "/healthz"):
            self.send_error(404)
            return
        try:
            metrics = collect()
            body = (metrics if self.path == "/metrics" else "ok\n").encode()
            status = 200
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            print(f"GPU collection failed: {error}", file=sys.stderr, flush=True)
            body, status = b"GPU collection failed\n", 503
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19400)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.once:
        print(collect(), end="")
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"GPU metrics listening on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
