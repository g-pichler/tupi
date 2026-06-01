# syntax=docker/dockerfile:1
# (enables RUN --mount=type=cache; needs BuildKit, the docker/compose default.)
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

# Docker Compose v2 plugin (docker.io apt pkg ships the CLI only)
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Rust toolchain (rust.d bootstraps rustup on demand) lives in shared /opt dirs,
# world-readable, so the runtime `node` user can use rustc/cargo. Crate binaries
# install into /usr/local/bin (already on PATH). See install-from-dir.sh cargo.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH="/opt/cargo/bin:${PATH}"

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
RUN bash /usr/local/bin/install-from-dir.sh cargo /build/rust.d

COPY build.d.available/ /build/build.d.available/
COPY build.d/ /build/build.d/
RUN bash /usr/local/bin/install-from-dir.sh build /build/build.d

RUN git config --system safe.directory '*'

# Bump NPM_CACHEBUST (e.g. to today's date) to force a fresh npm install layer
# without --no-cache, picking up new versions of the globally-installed CLIs.
ARG NPM_CACHEBUST=0
RUN echo "cachebust=${NPM_CACHEBUST}" \
    && npm install -g @earendil-works/pi-coding-agent @anthropic-ai/sdk @anthropic-ai/claude-code

# entrypoint.sh last so editing it only invalidates this cheap COPY.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["entrypoint.sh", "pi"]
