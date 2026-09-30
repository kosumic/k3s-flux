# Cimda cluster

This overlay manages the single-node k3s cluster on `cimda0728-tower`.
Flux reconciles `clusters/cimda` from the `main` branch of
`https://github.com/kosumic/k3s-flux` using a read-only SSH deploy key.

The initial overlay installs Flux only. Add this cluster's applications to
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
Any future GPU integration must preserve the existing NVIDIA driver and runtime
and coordinate GPU allocation with those users.
