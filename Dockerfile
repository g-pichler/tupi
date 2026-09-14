# syntax=docker/dockerfile:1
# (enables RUN --mount=type=cache; needs BuildKit, the docker/compose default.)

# ---------------------------------------------------------------------------
# Upstream TeX Live — opt-in, in its own STAGES. Enable with
# `./config.d.sh enable build 50_texlive.sh`; disabled, these stages produce an
# empty /opt/texlive and cost nothing. Enabled, the multi-GB install is
# downloaded ONCE and cached, isolated from every other layer: the daily npm
# cachebust, apt/python/rust edits, and other build.d units can't invalidate
# it, so rebuilds never re-download TeX Live (~30 min). Release/scheme/mirror
# are set in build.d.available/50_texlive.sh. Alternative to the distro
# `apt 00_texlive` unit — enable one or the other, not both.
#
# texlive-toggle turns "is the unit enabled?" into a file: /out holds the
# script if enabled, nothing otherwise. It reruns (cheaply) whenever build.d
# changes, but the COPY --from below is keyed on /out's CONTENT, so unless the
# script itself or its enabled state changes, the texlive stage stays cached.
# (Reading build.d/ directly in the texlive stage would rerun the install on
# every build.d toggle.)
# ---------------------------------------------------------------------------
FROM node:22-slim AS texlive-toggle
COPY build.d.available/50_texlive.sh /t/build.d.available/50_texlive.sh
COPY build.d/ /t/build.d/
RUN mkdir /out \
    && if [ -e /t/build.d/50_texlive.sh ]; then \
         cp /t/build.d.available/50_texlive.sh /out/; \
       fi

FROM node:22-slim AS texlive
COPY --from=texlive-toggle /out/ /tl/
# node slim ships neither perl nor curl; install-tl needs perl, curl fetches it.
RUN if [ -f /tl/50_texlive.sh ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        curl perl ca-certificates \
      && rm -rf /var/lib/apt/lists/* \
      && bash /tl/50_texlive.sh; \
    else \
      mkdir -p /opt/texlive; \
    fi

# ===========================================================================
# Main image.
# ===========================================================================
FROM node:22-slim

ARG COMPOSE_VERSION=2.32.4

# Core system packages — always present, deliberately lean. Heavy/optional
# tooling is NOT baked in here; add it via the drop-in package directories
# (apt.d/, python.d/, rust.d/, build.d/) instead. See those dirs' READMEs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    clang \
    mold \
    pkg-config \
    libssl-dev \
    gosu \
    docker.io \
    python3 \
    python3-pip \
    python3-venv \
    # ripgrep + fd: pi-coding-agent shells out to these; it finds them on PATH
    # (probes both `fd` and Debian's `fdfind`). `fd` symlink is for convenience.
    ripgrep \
    fd-find \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Bring the cached TeX Live (empty if the unit is disabled) into the final
# image. Placed right after the lean core, so only a core edit above re-copies
# it (a local copy, never a re-download); the apt/python/rust/build/npm layers
# all sit below and can't touch it.
COPY --from=texlive /opt/texlive /opt/texlive
# Expose TeX Live binaries on PATH for all users. /usr/local/bin precedes
# /usr/bin, so these win over any distro tools. No-op when /opt/texlive is
# empty (the unmatched glob fails the -f test).
RUN for b in /opt/texlive/*/bin/*/*; do \
      if [ -f "$b" ] && [ -x "$b" ]; then \
        ln -sf "$b" "/usr/local/bin/$(basename "$b")" || exit 1; \
      fi; \
    done

# Docker Compose v2 plugin (docker.io apt pkg ships the CLI only). The release
# asset is named by machine arch, so map from the build arch rather than
# hardcoding x86_64 — otherwise the build pulls an amd64 binary on Apple
# Silicon. BuildKit sets TARGETARCH automatically; dpkg is the fallback for a
# legacy non-BuildKit build, where it's unset.
ARG TARGETARCH
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) compose_arch=x86_64 ;; \
         arm64) compose_arch=aarch64 ;; \
         *) echo "unsupported arch for docker compose plugin: $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Rust toolchain (rust.d bootstraps rustup on demand) lives in shared /opt dirs,
# world-readable, so the runtime `node` user can use rustc/cargo. Crate binaries
# install into /usr/local/bin (already on PATH). See install-from-dir.sh cargo.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH="/opt/cargo/bin:${PATH}"

# Lean 4 (build.d bootstraps elan on demand) lives in a shared, world-readable
# /opt/elan, same idea as /opt/cargo above: the runtime `node` user (arbitrary
# host UID) can use lean/lake/elan with no HOME-dependent PATH/profile setup.
# build.d/10_lean4.sh installs there with --no-modify-path; these ENVs make it
# discoverable to every process in the image (ENV is inherited by all shells,
# unlike /etc/profile.d which only login shells source).
ENV ELAN_HOME=/opt/elan
ENV PATH="/opt/elan/bin:${PATH}"

# ---------------------------------------------------------------------------
# Drop-in package layers. Each <type>.d/ holds the *enabled* units — symlinks
# into <type>.d.available/ created by config.d.sh; install-from-dir.sh follows
# them (-L) and applies the lists in filename-sort order. Empty dirs are no-ops,
# so this is opt-in (manage with ./config.d.sh, not Dockerfile edits). We COPY
# the .available catalog alongside .d so the relative symlinks resolve in-image.
# These layers sit ABOVE the daily npm-cachebust layer so refreshing the CLIs
# never reinstalls e.g. TeX Live. Each ecosystem is its own COPY/RUN group, so
# editing one only rebuilds it and the layers below it.
#
# Granularity is per-ECOSYSTEM, not per-unit: a single RUN installs every
# enabled unit of that ecosystem together, so editing/enabling ANY apt unit
# reinstalls the whole apt set (and likewise for pip/cargo/build). To stop that
# from re-DOWNLOADING the big packages, the apt RUN below uses BuildKit cache
# mounts — the reinstall replays from cached .debs. pip/cargo/build do not yet
# have cache mounts, so changing those lists still re-downloads.
# ---------------------------------------------------------------------------
COPY install-from-dir.sh /usr/local/bin/install-from-dir.sh

COPY apt.d.available/ /build/apt.d.available/
COPY apt.d/ /build/apt.d/
# All enabled apt units install in this single RUN, so editing/enabling ANY apt
# unit invalidates it and reinstalls the whole set (incl. texlive-full, ~5GB).
# BuildKit cache mounts persist the downloaded .debs and apt lists across
# rebuilds, so the reinstall replays from cache without re-downloading. Removing
# docker-clean stops the base image from auto-deleting .debs after install (else
# the /var/cache/apt mount stays empty). install-from-dir.sh must NOT rm the
# apt lists for the same reason. sharing=locked serialises concurrent builds.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && bash /usr/local/bin/install-from-dir.sh apt /build/apt.d

COPY python.d.available/ /build/python.d.available/
COPY python.d/ /build/python.d/
RUN bash /usr/local/bin/install-from-dir.sh pip /build/python.d

COPY rust.d.available/ /build/rust.d.available/
COPY rust.d/ /build/rust.d/
# Toolchain rustup bootstraps when a rust.d unit lists crates. Set via .env /
# compose build arg (RUST_VERSION=1.83.0, nightly, nightly-2025-01-15, ...).
# Declared here, not at the top, so changing it only rebuilds this layer down.
ARG RUST_VERSION=stable
RUN RUST_VERSION="$RUST_VERSION" bash /usr/local/bin/install-from-dir.sh cargo /build/rust.d

COPY build.d.available/ /build/build.d.available/
COPY build.d/ /build/build.d/
# 50_texlive.sh is installed by the dedicated texlive stage above, not here.
RUN INSTALL_SKIP=50_texlive.sh bash /usr/local/bin/install-from-dir.sh build /build/build.d

RUN git config --system safe.directory '*'

# Bump NPM_CACHEBUST (e.g. to today's date) to force a fresh npm install layer
# without --no-cache, picking up new versions of the globally-installed CLIs.
ARG NPM_CACHEBUST=0
RUN echo "cachebust=${NPM_CACHEBUST}" \
    && npm install -g @earendil-works/pi-coding-agent @anthropic-ai/sdk @anthropic-ai/claude-code

# claude config symlink
RUN ln -s '/home/node/.claude/.claude.json' '/home/node/.claude.json'

# Build-time cargo installs into the shared /opt dirs (install-from-dir.sh
# exports its own RUSTUP_HOME/CARGO_HOME, so this ENV does not affect them). At
# *runtime* /opt/cargo is root-owned and read-only for the `node` user, so any
# `cargo build` dies trying to write CARGO_HOME (registry cache, git checkouts,
# the .package-cache lock). Point the runtime CARGO_HOME at HOME instead; the
# rustup proxies still live on PATH in /opt/cargo/bin and RUSTUP_HOME stays
# shared + read-only (rustc/cargo only read it; `rustup update` won't work).
# docker-compose.yml mounts a named volume here so the crate cache survives
# container restarts.
ENV CARGO_HOME=/home/node/.cargo
ENV PATH="/home/node/.cargo/bin:${PATH}"
RUN mkdir -p /home/node/.cargo && chown node:node /home/node/.cargo

# entrypoint.sh last so editing it only invalidates this cheap COPY.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["entrypoint.sh", "pi"]
