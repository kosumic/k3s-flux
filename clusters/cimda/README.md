# Cimda cluster

This overlay manages the single-node k3s cluster on `cimda0728-tower`.
Flux reconciles `clusters/cimda` from the `main` branch of
`https://github.com/kosumic/k3s-flux` using a read-only SSH deploy key.

The overlay installs Flux, Prometheus, and the NVIDIA GPU Operator with DCGM
Exporter. Add applications to
`kustomization.yaml` or wire separate Flux Kustomizations here as needed.
`clusters/my-cluster` is managed independently.

## Access and verification

On the tower, `cimda0728` can use `kubectl` with `~/.kube/config`.
On the administration workstation, use the dedicated kubeconfig explicitly:

```bash
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" get nodes
flux --kubeconfig="$HOME/.kube/cimda.yaml" check
flux --kubeconfig="$HOME/.kube/cimda.yaml" get all -A
flux --kubeconfig="$HOME/.kube/cimda.yaml" reconcile kustomization flux-system --with-source
```

Validate manifest changes from the repository root:

```bash
kubectl kustomize clusters/cimda >/dev/null
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" apply --dry-run=server -k clusters/cimda
```

Keep kubeconfigs and deploy keys outside this repository. The deploy-key private
key is stored in the cluster's `flux-system/flux-system` Secret.

The host is shared with users running GPU processes outside Kubernetes.
GPU integration must preserve the existing NVIDIA driver and runtime
and coordinate GPU allocation with those users.

## NVIDIA GPUs

The GPU Operator is pinned to `v26.7.1` and reuses the host driver, NVIDIA
Container Toolkit, and `/var/run/cdi/nvidia.yaml`. Driver/toolkit installation,
MIG changes and vGPU/VFIO/confidential-computing management are disabled. GPU
discovery and the device plugin remain enabled. Validator GPU
workloads and host `/dev/char` symlink creation are disabled.

Pods can request whole GPUs with `resources.limits.nvidia.com/gpu: 1`; the device
plugin supplies CDI devices through containerd. Coordinate GPU usage with the
host's other users: Kubernetes does not account for their host CUDA processes.
No time-slicing or MPS sharing is configured.

```bash
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" -n gpu-operator get pods
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" get clusterpolicy
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" get nodes -o custom-columns='NAME:.metadata.name,GPUS:.status.allocatable.nvidia\.com/gpu'
```

Ubuntu 20.04 is outside the Operator's current validated OS matrix. Preserve the
working host stack and verify compatibility before changing the pinned version.

## Prometheus and GPU metrics

`monitoring/` installs kube-prometheus-stack `91.8.2` with Prometheus Operator,
Prometheus, node-exporter, and kube-state-metrics. Grafana and Alertmanager are
not enabled. Unreachable k3s scheduler/controller/proxy endpoints and absent etcd
monitoring are disabled; the API server, kubelet, and CoreDNS remain monitored.

Prometheus retains up to seven days or 8 GB of metric blocks on a 15 Gi
`local-path` PVC. WAL/head data adds overhead, and local-path PVC sizes are not
filesystem quotas. Monitor free host disk space; this single-node storage has
no replication. Services use ClusterIP; node-exporter does not bind a host port.

The existing GPU Operator manages DCGM Exporter with an embedded DCGM engine.
Driver and toolkit installation remain disabled. Its custom metrics list collects
basic utilization, framebuffer usage, temperature, power, clock, and XID errors;
no profiling counters or diagnostic workloads are enabled. GPU metrics include
host activity, but Kubernetes pod labels only identify Kubernetes allocations.
The GPU Operator HelmRelease waits for Prometheus so ServiceMonitor CRDs exist.
Its ServiceMonitor carries `release: prometheus` for cross-namespace discovery.

Open the Prometheus UI locally:

```bash
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" -n monitoring \
  port-forward svc/prometheus-prometheus 9090:9090
```

Visit `http://localhost:9090`. Useful queries: `DCGM_FI_DEV_GPU_UTIL`,
`DCGM_FI_DEV_FB_USED`, and `up{job="nvidia-dcgm-exporter"}`.

Verify reconciliation and workloads:

```bash
flux --kubeconfig="$HOME/.kube/cimda.yaml" get helmreleases -A
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" -n monitoring get pods,pvc
kubectl --kubeconfig="$HOME/.kube/cimda.yaml" -n gpu-operator \
  get pods,servicemonitors -l app=nvidia-dcgm-exporter
```
