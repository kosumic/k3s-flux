# k3s-flux

Flux configuration for `clusters/my-cluster` and `clusters/cimda`.

## Validation

`.github/workflows/validate.yaml` validates pull requests, pushes to `main`, and
manual runs. It checks YAML syntax, renders every tracked cluster overlay, and
validates Kubernetes and Flux resources with kubeconform.

Run the same checks locally with `bash scripts/validate.sh`. The required tools
are listed in the script; they can be supplied with:

```bash
nix shell nixpkgs#kustomize nixpkgs#kubeconform nixpkgs#yq-go -c bash scripts/validate.sh
```

The default Kubernetes schema version is `1.36.4`, matching both clusters. Update
this default when upgrading Kubernetes, or set `KUBERNETES_VERSION` for a local
compatibility check. Flux schemas are selected separately for each cluster from
the version label in its generated `flux-system/gotk-components.yaml`.
`FLUX_VERSION` can override that selection for a local compatibility check.
Third-party resources without available schemas are skipped; Flux resources
receive a separate strict schema check.

Kustomize Components are validated through a containing overlay, not built
independently. Register each component in `component_validation_overlays` in
`scripts/validate.sh`; validation fails if a component has no registered overlay.
The inactive Mistral.rs component is checked through
`benchmarks/qwen38-engines/preview`, without deploying that preview.

## Flux updates

`.github/workflows/update-flux.yaml` runs at 09:00 UTC on the first day of each
month and can also be run manually. It regenerates both clusters' Flux component
manifests using the latest stable Flux CLI and validates all overlays before
committing changes to the selected branch. Flux then applies commits on `main`
to the clusters. Validation happens in the update job because pushes using the
GitHub Actions token do not trigger another push workflow.

Both clusters currently use the default four controllers and `ghcr.io/fluxcd`.
If a cluster needs different components or install settings, update the workflow's
export command to preserve those settings.

Use the manual workflow's `dry-run` option to exercise regeneration and validation
without committing changes or upgrading either cluster. No cluster credentials
or additional GitHub token are required.
