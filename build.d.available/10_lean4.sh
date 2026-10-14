#!/usr/bin/env bash
# Lean 4 — install elan (Lean version manager) + the pinned toolchain into a
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
# Dockerfile owns PATH; don't let elan edit shell rc files. Pinned to
# leanprover/lean4:4.32.0 rather than `stable` so builds are reproducible.
# Bump this intentionally; otherwise elan follows the moving `stable` channel.
curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
  | sh -s -- -y --no-modify-path --default-toolchain leanprover/lean4:4.32.2

# Materialise the default toolchain into the layer so the first runtime
# lean/lake invocation doesn't trigger a download (and fails the build now if
# the toolchain can't be fetched, rather than silently breaking at runtime).
"$ELAN_HOME/bin/lean" --version >/dev/null

# World-readable so any runtime UID can use it (entrypoint remaps node→HOST_UID).
# Also grant world write: the runtime user is `node` remapped to an arbitrary
# host UID, so we can't chown to a fixed UID at build. Leave /opt/elan writable
# so `elan install` can fetch NEW toolchains at runtime (e.g. `stable`,
# `leanprover/lean4:4.XX`), not just use the pinned default. Single-user gosu
# container, so world write on a shared, no-secrets home is acceptable.
# Uppercase X only adds execute where a dir (or someone) already has execute,
# so binaries keep their bits; a+rw covers toolchain dirs elan must write.
chmod -R a+rwX "$ELAN_HOME"
