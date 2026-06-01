#!/usr/bin/env bash
#
# install-from-dir.sh KIND DIR
#
# Installs packages declared by drop-in files in DIR. Files are processed in
# filename-sort order (so a `00_`-prefixed file is applied before `20_`), which
# lets you control ordering (e.g. install texlive before something that needs
# it). Within the package kinds, each non-empty, non-comment line is one package
# name; `#` starts a comment. `.gitkeep`, `.gitignore`, and `README.md` are
# ignored.
#
#   KIND = apt   -> apt-get install the listed packages
#   KIND = pip   -> pip install the listed packages
#   KIND = cargo -> cargo install the listed crates (bootstraps rustup if needed)
#   KIND = build -> execute each file as a shell script, in order (escape hatch
#                   for things no package manager covers: binary downloads, apt
#                   repos, etc.)
#
# A missing or empty directory is a no-op, so every kind is fully optional.
set -euo pipefail

kind="${1:?usage: install-from-dir.sh <apt|pip|cargo|build> <dir>}"
dir="${2:?usage: install-from-dir.sh <apt|pip|cargo|build> <dir>}"

if [ ! -d "$dir" ]; then
  echo "[$kind] $dir does not exist — skipping"
  exit 0
fi

# Drop-in files, sorted by name, excluding bookkeeping files. Enabled units are
# symlinks into <type>.d.available/ (created by config.d.sh), so -L dereferences
# them — a symlink to a regular file then matches -type f.
mapfile -t files < <(find -L "$dir" -maxdepth 1 -type f \
  ! -name '.gitkeep' ! -name '.gitignore' ! -name 'README.md' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[$kind] no drop-in files in $dir — skipping"
  exit 0
fi

# build: run each file as a script, in order.
if [ "$kind" = "build" ]; then
  for f in "${files[@]}"; do
    echo "[build] running $(basename "$f")"
    bash "$f"
  done
  exit 0
fi

# Package kinds: collect tokens across all files, preserving file order.
pkgs=()
for f in "${files[@]}"; do
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"            # strip comments
    for tok in $line; do          # word-split, drops blank lines
      pkgs+=("$tok")
    done
  done < "$f"
done

if [ "${#pkgs[@]}" -eq 0 ]; then
  echo "[$kind] files present but no packages listed — skipping"
  exit 0
fi

echo "[$kind] installing: ${pkgs[*]}"
case "$kind" in
  apt)
    # NB: do NOT `rm -rf /var/lib/apt/lists/*` here. The Dockerfile runs this
    # apt layer with BuildKit cache mounts on /var/cache/apt + /var/lib/apt, so
    # the lists/.debs live in the build cache (not committed to the image layer)
    # and are reused on rebuild to avoid re-downloading texlive et al. An rm
    # would wipe that cache. Keeping it out also keeps the image layer small,
    # since the mounted dirs aren't part of the committed filesystem.
    apt-get update
    apt-get install -y --no-install-recommends "${pkgs[@]}"
    ;;
  pip)
    pip install --no-cache-dir --break-system-packages "${pkgs[@]}"
    ;;
  cargo)
    # Install into world-readable shared dirs, NOT root's HOME: the agent runs
    # as the `node` user (entrypoint remaps it to HOST_UID at runtime), and
    # /root is mode 700 — anything under ~root/.cargo would be unreachable. Set
    # RUSTUP_HOME/CARGO_HOME to /opt and drop crate binaries into /usr/local/bin
    # (already on PATH for all users). chmod a+rX so any runtime UID can use it.
    export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
    if ! command -v cargo >/dev/null 2>&1; then
      echo "[cargo] Rust toolchain not found — bootstrapping rustup"
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal
      export PATH="/opt/cargo/bin:$PATH"
    fi
    cargo install --root /usr/local "${pkgs[@]}"
    chmod -R a+rX /opt/rustup /opt/cargo
    ;;
  *)
    echo "[install-from-dir] unknown kind: $kind" >&2
    exit 1
    ;;
esac
