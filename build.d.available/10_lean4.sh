#!/usr/bin/env bash
# Lean 4 — install elan (Lean version manager) + the stable toolchain into a
# shared, world-readable home at /opt/elan.
#
# This mirrors the /opt/cargo + /opt/rustup pattern (see install-from-dir.sh's
# cargo branch and the Dockerfile ENV block): the runtime agent runs as the
# `node` user remapped to an arbitrary host UID, so a per-HOME install is
# useless — at build time HOME=/root (mode 700, unreachable by `node`), and
# /etc/profile.d or ~/.bashrc PATH edits are never sourced by the agent's
# non-login, non-interactive shells. Instead elan lives in /opt/elan and the
# Dockerfile puts /opt/elan/bin on the image PATH + sets ELAN_HOME, so
# lean/lake/elan work for every user with no profile sourcing required.
set -euo pipefail

ELAN_HOME=/opt/elan
export ELAN_HOME

# Install elan + default toolchain into the shared home. --no-modify-path: the
# Dockerfile owns PATH; don't let elan edit shell rc files.
curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
  | sh -s -- -y --no-modify-path --default-toolchain leanprover/lean4:stable

# Materialise the default toolchain into the layer so the first runtime
# lean/lake invocation doesn't trigger a download (and fails the build now if
# the toolchain can't be fetched, rather than silently breaking at runtime).
"$ELAN_HOME/bin/lean" --version >/dev/null

# World-readable so any runtime UID can use it (entrypoint remaps node→HOST_UID).
chmod -R a+rX "$ELAN_HOME"
