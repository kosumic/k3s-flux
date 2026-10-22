# Cimda ingress controller

Flux installs Traefik in `ingress-system`, using chart `41.6.1` (Traefik
`v3.7.13`). The k3s bundled Traefik and Helm controller remain disabled.

Traefik uses the host network on unprivileged HTTP port 8000. Its ClusterIP
Service exposes port 80 at the tower's existing Tailscale address,
`100.100.130.75`, through `externalIPs` and `externalTrafficPolicy: Local`.
ServiceLB and NodePort exposure are not used.

The Service routes to a host-network endpoint, so tailnet connections stay
local to the node instead of entering Tailscale's forwarding masquerade rule.
With a normal pod endpoint, that rule rewrites the client to the Kubernetes
bridge address even when `externalTrafficPolicy: Local` is set.

Qwen and ComfyUI retain their tailnet and loopback allowlists, plus only the
tower's own node address, `192.168.33.132/32`, because Kubernetes masquerades
locally originated Service connections to that address. This lets Whip's SSH
browser tunnel use the same URL. Direct LAN requests to these routes on port
8000 fail the allowlist. Grafana has no ingress IP allowlist and permits
anonymous Viewer access.

The container keeps UID 65532, all capabilities dropped, privilege escalation
disabled and a read-only root filesystem. Health, management, metrics and the
unused HTTPS entrypoint bind to loopback. Kubernetes DNS uses
`ClusterFirstWithHostNet`, and probes use the loopback management listener.
A `Recreate` strategy avoids host-port conflicts during later upgrades;
updates briefly interrupt ingress connections.

Only Ingress resources and Traefik CRDs in `llama-qwen38`,
`comfyui-qwen-image` and `monitoring` are watched. Ingress status publishes the
Tailscale address directly without looking up an unwatched Service.

Traefik is not the default IngressClass. Dashboard exposure and access logging
are disabled. Untrusted forwarding headers are not accepted; the allowlists
check the connection peer. The published address on port 80 uses Tailscale;
host port 8000 is plain HTTP.

Qwen uses `/qwen`, ComfyUI `/comfyui/` and Grafana `/grafana/`. Only Qwen and
ComfyUI use IPAllowList middleware.

## Validation

```sh
kubectl kustomize clusters/cimda/traefik >/dev/null
kubectl kustomize clusters/cimda >/dev/null
kubectl apply --dry-run=server --server-side --force-conflicts \
  --field-manager=codex-validation -k clusters/cimda
```

`force-conflicts` is only for dry-run validation of Flux-owned objects.
Deploy through Git and Flux. Check Grafana health and the GPU dashboard over
Tailscale, both remotely and from the tower, plus the other running backends.
Verify Qwen and ComfyUI reject LAN requests while Grafana accepts them on
port 8000. Confirm the former NodePort is gone and that loopback health,
Traefik and Flux report Ready.
