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

The ingress allowlists retain the tailnet and loopback ranges. They also allow
only the tower's own node address, `192.168.33.132/32`, because Kubernetes
masquerades locally originated Service connections to that address. This lets
Whip's SSH browser tunnel use the same URL. The LAN subnet and pod bridge are
not trusted. Direct LAN requests to port 8000 still fail the allowlist.

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
check the connection peer. HTTP relies on Tailscale rather than public TLS.

Qwen uses `/qwen`, ComfyUI `/comfyui/` and Grafana `/grafana/`. Each route keeps
its IPAllowList middleware.

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
Verify LAN requests are rejected, the former NodePort is gone, and loopback
health, Traefik and Flux report Ready.
