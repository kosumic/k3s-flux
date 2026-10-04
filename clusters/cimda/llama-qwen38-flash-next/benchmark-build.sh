#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential curl git pkg-config libssl-dev libomp-dev cmake clang
export RUSTUP_HOME=/build/rustup
export CARGO_HOME=/build/cargo
export PATH=/build/cargo/bin:/usr/local/cuda/bin:$PATH
export CUDA_COMPUTE_CAP=86
export CARGO_BUILD_JOBS=8
export CARGO_INCREMENTAL=0
export CARGO_NET_GIT_FETCH_WITH_CLI=true
export CARGO_NET_RETRY=5
curl --fail --silent --show-error --location https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.94.0 --no-modify-path
revision=3f2515e9b5adc2ac44949c128c50a13b15721294
if ! test -d /build/source/.git; then
  git clone --filter=blob:none --no-checkout https://github.com/EricLBuehler/mistral.rs.git /build/source
fi
cd /build/source
git checkout --detach "$revision"
test "$(git rev-parse HEAD)" = "$revision"
cargo check --locked --no-default-features --features 'cuda flash-attn' -p mistralrs-cli
cargo build --release --locked --no-default-features --features 'cuda flash-attn' -p mistralrs-cli
mkdir -p /build/bin
install -m 755 target/release/mistralrs /build/bin/mistralrs
sha256sum /build/bin/mistralrs
ldd /build/bin/mistralrs
/build/bin/mistralrs --version
printf '%s\n' "$revision" > /build/bin/revision
