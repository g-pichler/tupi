#!/usr/bin/env bash
set -e

# Resolve the real script location, following symlinks. This lets the file be
# symlinked as claude.sh / pi.sh (or from ~/bin, etc.) and still find the
# docker-compose.yml that lives next to it.
#
# We can't use `readlink -f`: it's GNU-only. macOS ships BSD readlink (no -f),
# so resolve the symlink chain by hand — portable across Linux, macOS, and
# Git Bash/WSL on Windows.
resolve() {
  local src="$1" dir
  while [ -L "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    # Relative symlink targets are resolved against the link's own directory.
    [ "${src#/}" = "$src" ] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}
PI_HOME="$(resolve "${BASH_SOURCE[0]}")"

# Dispatch by invocation name: claude.sh → claude, pi.sh → pi. Anything else
# (including run.sh) defaults to claude.
NAME="$(basename "$0")"
case "$NAME" in
  pi*)     MODE=pi ;;
  *)       MODE=claude ;;
esac

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  cat <<EOF
Usage: $NAME [options] [-- agent args...]

Options:
  --shell    Start a bash shell in the container instead of the agent
  -h, --help Show this help

Invoked as '$NAME' → agent: $MODE
All other arguments are passed through.

Ollama is optional and lives behind a compose profile. To start it:
  docker compose -f "$PI_HOME/docker-compose.yml" --profile ollama up -d
EOF
  exit 0
fi

# Daily cachebust on the npm-install layer: picks up fresh
# @anthropic-ai/claude-code / @earendil-works/pi-coding-agent once per day.
export NPM_CACHEBUST=$(date +%Y%m%d)
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)

COMPOSE=(docker compose -f "$PI_HOME/docker-compose.yml")

# User customizations (gitignored): compose override units enabled via config.d.sh
# get symlinked into compose.d/; layer each on top of the tracked compose file, in
# sorted order (later files override earlier ones). Catalog: compose.d.available/.
# The -f test follows symlinks and skips the literal glob when nothing matches.
for extra in "$PI_HOME"/compose.d/*.yml; do
  [[ -f "$extra" ]] && COMPOSE+=(-f "$extra")
done

RUN=(run --rm --build -v "$(pwd):$(pwd)" -w "$(pwd)")

if [[ "$1" == "--shell" ]]; then
  shift
  exec "${COMPOSE[@]}" "${RUN[@]}" --entrypoint entrypoint.sh pi bash "$@"
fi

case "$MODE" in
  claude)
    exec "${COMPOSE[@]}" "${RUN[@]}" --entrypoint entrypoint.sh \
         pi claude --dangerously-skip-permissions "$@"
    ;;
  pi)
    # Image ENTRYPOINT is already ["entrypoint.sh", "pi"] — just pass args.
    exec "${COMPOSE[@]}" "${RUN[@]}" pi "$@"
    ;;
esac
