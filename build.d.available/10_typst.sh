#!/usr/bin/env bash
# Typst typesetter — prebuilt binary (much faster than `cargo install typst-cli`).
set -euo pipefail

TYPST_VERSION=0.14.2

curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
  -o /tmp/typst.tar.xz
tar -xf /tmp/typst.tar.xz -C /tmp typst-x86_64-unknown-linux-musl/typst
mv /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst
chmod +x /usr/local/bin/typst
rm -rf /tmp/typst-x86_64-unknown-linux-musl /tmp/typst.tar.xz
