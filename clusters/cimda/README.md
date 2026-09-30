# Cimda cluster

This overlay manages the single-node k3s cluster on `cimda0728-tower`.
Flux reconciles `clusters/cimda` from the `main` branch of
`https://github.com/kosumic/k3s-flux` using a read-only SSH deploy key.

The overlay installs Flux and the NVIDIA GPU Operator. Add applications to
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
MIG changes, vGPU/VFIO/confidential-computing management, and DCGM monitoring are
disabled. GPU discovery and the device plugin remain enabled. Validator GPU
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
