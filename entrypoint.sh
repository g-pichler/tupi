#!/usr/bin/env bash
set -e

PI_DIR="${PI_CODING_AGENT_DIR:-/pi-config}"

# Install dependencies for any pi extensions that have a package.json
for pkg in "$PI_DIR"/extensions/*/package.json; do
  [ -f "$pkg" ] || continue
  dir=$(dirname "$pkg")
  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing dependencies for extension: $(basename "$dir")"
    (cd "$dir" && npm install --silent)
  fi
done

# Remap the baked-in `node` user to the host UID/GID if running as root. We
# reuse the single `node` user (HOME /home/node) rather than creating a separate
# user on mismatch — that keeps HOME constant, so host config only needs to be
# bind-mounted at /home/node, not at two paths.
if [ "$(id -u)" = "0" ] && [ -n "$HOST_UID" ]; then
  TARGET_GID="${HOST_GID:-$HOST_UID}"
  PI_USER=node
  PI_HOME=/home/node

  # Renumber node to the host UID/GID when they differ. `usermod -u` also
  # re-chowns files it finds under HOME, so the baked-in home contents follow.
  # `-o` permits a non-unique id in the unlikely event of a clash.
  if [ "$(id -u node)" != "$HOST_UID" ]; then
    groupmod -o -g "$TARGET_GID" node 2>/dev/null || true
    usermod -o -u "$HOST_UID" -g "$TARGET_GID" node 2>/dev/null || true
  elif [ "$(id -g node)" != "$TARGET_GID" ]; then
    groupmod -o -g "$TARGET_GID" node 2>/dev/null || true
    usermod -g "$TARGET_GID" node 2>/dev/null || true
  fi

  # Ensure user can access the Docker socket, IF it was mounted in. The socket
  # is opt-in (enable the compose docker.yml unit) — when absent this is a no-op.
  if [ -S /var/run/docker.sock ]; then
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
    groupadd -o -g "$DOCKER_GID" dockerhost 2>/dev/null || true
    usermod -aG dockerhost "$PI_USER"
  fi

  find "$PI_HOME" -not -path "$PI_HOME/.gitconfig" -not -path "$PI_HOME/.claude*" -exec chown "$HOST_UID:$TARGET_GID" {} +
  chown -R "$HOST_UID:$TARGET_GID" "$PI_DIR"

  # Rust lives in world-readable /opt/{cargo,rustup} (see Dockerfile /
  # install-from-dir.sh), already on the image's ENV PATH — no per-start copy
  # into HOME needed. gosu inherits that PATH and RUSTUP_HOME/CARGO_HOME.
  export HOME="$PI_HOME"
  exec gosu "$PI_USER" "$@"
fi

exec "$@"
