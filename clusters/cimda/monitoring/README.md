# Continuous GPU monitoring

Dashboard: http://cimda0728-tower/grafana/d/gpu-usage/gpu-usage

IP fallback: http://100.100.130.75/grafana/d/gpu-usage/gpu-usage

CIMDA k3s runs Prometheus and Grafana. The dashboard shows all physical GPUs:
two RTX A6000s on cimda and four A100 80 GB GPUs on hy8. It includes current
utilization, VRAM used/free/capacity, history, temperature, power and collection health.
Host and GPU filters apply to the GPU panels.

GPU scrapes and recording rules run every 15 seconds. Existing Prometheus retention
is 7 days with an 8 GB size cap; whichever limit is reached first applies. Missing
samples appear as gaps. No external notification channel is configured.

## Collection and access

Cimda reuses the GPU Operator's DCGM exporter with basic telemetry only. The
explicit cimda ServiceMonitor adds consistent host/UUID/model labels. The GPU
Operator's own ServiceMonitor is disabled to avoid duplicate scrapes.

Hy8 runs the standard-library nvidia-smi exporter from hosts/gpu-monitoring.
It executes nvidia-smi for each scrape, times out after 5 seconds and returns HTTP
503 if required readings cannot be collected. It never creates a CUDA context or
allocates GPU memory. Optional temperature/power readings may be absent.

The hy8 exporter listens on 127.0.0.1:19400. CIMDA's user service forwards
10.42.0.1:19400 (the k3s bridge) through SSH to hy8 loopback. The selectorless
Service and EndpointSlice let Prometheus scrape this tunnel. Neither exporter
nor tunnel listens on a public or LAN address. Prometheus uses EndpointSlice
service discovery. Both host services restart automatically; lingering is enabled
for cimda0728 and zelinli6 so they run without an interactive login.

Grafana is available through the existing Tailscale-only Traefik ingress at
/grafana/. Anonymous tailnet users have Viewer access. The admin password is
generated locally and kept in Kubernetes Secret grafana-admin, outside Git.
Recovery files on CIMDA are mode 0600:
- /home/data2/zelinrick/nautilus/gpu-monitoring/grafana-admin-user
- /home/data2/zelinrick/nautilus/gpu-monitoring/grafana-admin-password

Grafana uses a retained static local PV at
/home/data2/zelinrick/nautilus/gpu-monitoring/grafana.
Prometheus retains its existing PVC and storage settings.

## Operations

On CIMDA:

~~~sh
systemctl --user status hy8-gpu-tunnel.service
systemctl --user restart hy8-gpu-tunnel.service
curl --fail http://10.42.0.1:19400/healthz
kubectl -n monitoring get pods,pvc,servicemonitor
kubectl -n monitoring get prometheus prometheus-prometheus
kubectl -n flux-system annotate --overwrite gitrepository flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)"
kubectl -n flux-system annotate --overwrite kustomization flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)"
~~~

On hy8:

~~~sh
systemctl --user status hy8-gpu-exporter.service
systemctl --user restart hy8-gpu-exporter.service
curl --fail http://127.0.0.1:19400/healthz
journalctl --user -u hy8-gpu-exporter.service --since '10 minutes ago'
~~~

After editing the exporter or hy8 unit, copy those files to
/home/zelinli6/nautilus/gpu-monitoring/ on hy8. Run systemctl --user daemon-reload
and restart the exporter. The CIMDA tunnel unit is linked to its Git checkout;
reload the user manager after edits to that unit.

To recreate the admin Secret from the retained recovery files, on CIMDA:

~~~sh
kubectl -n monitoring create secret generic grafana-admin \
  --from-file=admin-user=/home/data2/zelinrick/nautilus/gpu-monitoring/grafana-admin-user \
  --from-file=admin-password=/home/data2/zelinrick/nautilus/gpu-monitoring/grafana-admin-password
~~~

Recording metrics are gpu_utilization_percent, gpu_memory_used_bytes,
gpu_memory_total_bytes, gpu_memory_free_bytes, gpu_memory_utilization_percent,
gpu_temperature_celsius and gpu_power_watts. Labels are host, gpu, uuid and model.
GPU indices are physical nvidia-smi indices, not CUDA process-local indices.

## Validation

On CIMDA, from /home/data2/zelinrick/nautilus/repos/k3s-flux:

~~~sh
source /home/cimda0728/.local/bin/env
UV_CACHE_DIR=/home/data2/zelinrick/nautilus/uv-cache \
  uv run --offline --no-project --python 3.12 python hosts/gpu-monitoring/test_exporter.py
kubectl kustomize clusters/cimda/monitoring | kubectl create --dry-run=client -f -
kubectl apply --dry-run=server --server-side --force-conflicts \
  --field-manager=codex-validation -k clusters/cimda/monitoring
kubectl kustomize clusters/cimda >/dev/null
~~~

force-conflicts is used only for the dry run because Flux owns the existing
release values; actual deployment goes through Git and Flux.

References: [Prometheus Operator ServiceMonitor API](https://prometheus-operator.dev/docs/api-reference/api/),
[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/),
[Grafana reverse proxy setup](https://grafana.com/tutorials/run-grafana-behind-a-proxy/).

## Verified deployment

Live verification passed on 2026-10-14:
- Both GPU scrape targets are UP at 15-second intervals.
- All seven utilization, VRAM, temperature and power metrics contain 2 cimda GPUs and 4 hy8 GPUs.
- Historical queries return samples for all six GPUs.
- Grafana provisions the 11-panel dashboard and its Prometheus query returns six GPU frames.
- Dashboard HTML, health and dashboard API return HTTP 200 over Tailscale.
- Connecting to the LAN address times out; access through the Tailscale address succeeds.
- Prometheus, GPU Operator and Traefik releases report Ready; Grafana has 3/3 containers Ready.
- The hy8 exporter and CIMDA tunnel are enabled, with user lingering enabled on both hosts.
- Exporter unit tests, client/server manifest dry runs and the full cluster render passed.

The live snapshot is /home/data2/zelinrick/nautilus/gpu-monitoring/verification.json.
The Flux CLI is absent on this host; the kubectl annotations above trigger the
same controller reconciliation.

## Storage recovery

K3s runtime data, local-path volumes (including Prometheus), kubelet state and pod
logs now use bind mounts under /home/data2/zelinrick/nautilus/k3s-host. Existing
Kubernetes paths and PVC identities are preserved. The old disabled Qwen model
weights were removed at the user's request to make room for this migration.

See [host storage operations](../../../hosts/k3s-storage/README.md) for mount,
rollback and verification details. The old data bind remains underneath the
active data2 bind until reboot; /etc/fstab persistently selects data2.
