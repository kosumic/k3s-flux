#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
kubernetes_version="${KUBERNETES_VERSION:-1.36.4}"
schema_root="$(mktemp -d)"

cleanup() {
  rm -rf -- "${schema_root}"
}
trap cleanup EXIT

for command in curl git kubeconform kustomize tar yq; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "ERROR: ${command} is required" >&2
    exit 1
  fi
done

echo "INFO: validating YAML syntax"
while IFS= read -r -d '' file; do
  yq eval 'true' "${repo_root}/${file}" >/dev/null
done < <(git -C "${repo_root}" ls-files -z '*.yaml' '*.yml')

kubernetes_schema_flags=(
  -strict
  -ignore-missing-schemas
  -kubernetes-version "${kubernetes_version}"
  -schema-location default
  -summary
)

# Cache schemas by the Flux version actually committed for each cluster.
declare -A cluster_flux_versions

echo "INFO: rendering and validating Kustomize overlays (Kubernetes ${kubernetes_version})"
while IFS= read -r -d '' file; do
  cluster="${file#clusters/}"
  cluster="${cluster%%/*}"
  if [[ -z "${cluster_flux_versions[${cluster}]:-}" ]]; then
    components="${repo_root}/clusters/${cluster}/flux-system/gotk-components.yaml"
    flux_version="${FLUX_VERSION:-$(yq eval -r -N \
      'select(.kind == "Namespace" and .metadata.name == "flux-system") | .metadata.labels."app.kubernetes.io/version"' \
      "${components}")}"
    if [[ ! "${flux_version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
      echo "ERROR: cannot determine Flux version for clusters/${cluster}" >&2
      exit 1
    fi
    cluster_flux_versions["${cluster}"]="${flux_version}"
  fi
  flux_version="${cluster_flux_versions[${cluster}]}"
  flux_schema_dir="${schema_root}/${flux_version}/master-standalone-strict"
  if [[ ! -d "${flux_schema_dir}" ]]; then
    echo "INFO: downloading Flux ${flux_version} schemas"
    mkdir -p "${flux_schema_dir}"
    curl --fail --silent --show-error --location --retry 3 \
      "https://github.com/fluxcd/flux2/releases/download/${flux_version}/crd-schemas.tar.gz" \
      | tar -xz -C "${flux_schema_dir}"
  fi

  overlay="${repo_root}/${file%/kustomization.yaml}"
  rendered="${schema_root}/rendered.yaml"
  flux_resources="${schema_root}/flux-resources.yaml"
  echo "INFO: validating ${file%/kustomization.yaml} (Flux ${flux_version})"
  kustomize build "${overlay}" --load-restrictor=LoadRestrictionsNone >"${rendered}"
  kubeconform "${kubernetes_schema_flags[@]}" "${rendered}"

  yq eval-all \
    'select(.apiVersion != null and (.apiVersion | test("toolkit\\.fluxcd\\.io/")))' \
    "${rendered}" >"${flux_resources}"
  if [[ -s "${flux_resources}" ]]; then
    kubeconform -strict -schema-location "${flux_schema_dir}/all.json" -summary "${flux_resources}"
  fi
done < <(git -C "${repo_root}" ls-files -z 'clusters/*/kustomization.yaml')

echo "INFO: all manifests passed validation"
