#!/usr/bin/env bash
# Soufflé Datalog. Not in the Debian bookworm repos, so we grab the upstream
# .deb built for Ubuntu 22.04 (its deps resolve fine on bookworm).
set -euo pipefail

SOUFFLE_VERSION=2.5

curl -fsSL "https://github.com/souffle-lang/souffle/releases/download/${SOUFFLE_VERSION}/x86_64-ubuntu-2204-souffle-${SOUFFLE_VERSION}-Linux.deb" \
  -o /tmp/souffle.deb
apt-get update
apt-get install -y --no-install-recommends /tmp/souffle.deb
rm -f /tmp/souffle.deb
rm -rf /var/lib/apt/lists/*
