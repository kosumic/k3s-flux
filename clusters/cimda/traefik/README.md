# Cimda ingress controller

Traefik is installed by Flux HelmRelease in `ingress-system`, using chart
`41.6.1` (Traefik `v3.7.13`). The k3s bundled Traefik and Helm controller remain
disabled; Flux owns this installation. The existing k3s ServiceLB exposes its
LoadBalancer Service on HTTP port 80. No Helm CLI installation is required.

The Service uses `externalTrafficPolicy: Local` and keeps NodePort allocation
enabled: ServiceLB needs the NodePort for this mode. Its `externalIPs` includes
the tower's existing Tailscale address `100.100.130.75`, which routes tailnet
traffic directly through Kubernetes without ServiceLB's extra masquerade hop.
This preserves the peer IP needed by the Qwen IPAllowList middleware.

Only Ingress resources and Traefik CRDs in namespace `llama-qwen38` are watched.
Traefik is not marked as the default IngressClass. Dashboard exposure and access
logging are disabled. Untrusted forwarded headers are not accepted, and the
model middleware evaluates the actual connection peer, not X-Forwarded-For.

Qwen is available under `/qwen`; see the model directory's README for the API,
smoke checks, and rollback. The route is restricted to Tailscale address ranges
and loopback by middleware. The Service also declares source ranges as an extra
layer; do not remove the middleware or assume all load-balancer paths preserve
the source address. HTTP relies on the Tailscale connection, not public TLS.
