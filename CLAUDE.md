# pi sandbox

Docker-based dev container bundling the [`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Claude Code, and the Anthropic SDK on a lean core (Node, git, build tools, Python 3, ripgrep/fd). Heavier tooling (Rust, TeX Live, OCR, Typst, Soufflé, scientific Python) is opt-in via the `*.d/` drop-in package lists. A GPU-backed Ollama service is wired up via `docker-compose`.

## Dogfooding note

This repo is dogfed: when you (Claude) are editing files here, you are almost certainly running *inside* the sandbox this repo defines (launched via `claude.sh`). Changes to `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, or the wrapper scripts only take effect on the **next** container run — the image you're executing in right now was built before your edit. Rebuild (`docker compose build` or just rerun `claude.sh`, which passes `--build`) to actually test your changes.

Consequences worth keeping in mind:
- Don't assume a tool is missing just because `which` fails in the current shell — check the `Dockerfile` first; it may have been added after this container started.
- `/workspace` and the host cwd are both bind-mounted, so edits here are visible to the host immediately.
- `~/.claude` and `~/.claude.json` are bind-mounted from the host, so your memory, settings, and auth persist across container runs and are shared with the host's Claude Code.

## Entry points

- `run.sh` — the real dispatcher. Picks the agent based on `basename "$0"`: a name starting with `pi` runs the `pi` agent, anything else runs Claude Code with `--dangerously-skip-permissions`. `--shell` drops into bash instead.
- `claude.sh`, `pi.sh` — symlinks to `run.sh`. Symlink from `~/bin` or elsewhere as desired; `run.sh` resolves its real location by walking the symlink chain by hand (portable `resolve()` fn, not GNU `readlink -f`, so macOS works) so the compose file is still found.
- All invocations mount the caller's `$(pwd)` into the container at the same path and `cd` into it, so relative paths Just Work.

## Optional services

- **Ollama** lives behind the `ollama` compose profile and is not started by default (it requires an NVIDIA GPU + nvidia-container-toolkit, so the setup works on GPU-less machines out of the box). To bring it up:
  ```
  docker compose --profile ollama up -d ollama
  ```
  The `pi` service's `OLLAMA_HOST` defaults to `http://ollama:11434` and can be overridden via the environment (e.g. point at a host-side Ollama on another machine).

## Container layout

- `entrypoint.sh` reconciles UIDs: it remaps the baked-in `node` user (via `usermod`/`groupmod`) to `HOST_UID`/`HOST_GID` so bind-mounted files are owned by the host user. A single user is reused, so `HOME` is always `/home/node` and host config mounts only there. If the Docker socket is mounted (opt-in, see below) it also joins that socket's group.
- **Host Docker access is opt-in and dangerous.** The base compose does NOT mount `/var/run/docker.sock`; users opt in by enabling the unit (`./config.d.sh enable compose docker.yml`; catalog: `compose.d.available/docker.yml`). Mounting it == root on the host, and the agent runs `--dangerously-skip-permissions`. Keep the prominent security warning intact when editing the unit or README; don't quietly re-add the socket to the tracked compose file.
- `pi-config/agent` is bind-mounted to `/pi-config` and auto-`npm install`s any `extensions/*/package.json`. `models.json` API keys support `${ENV_VAR}` interpolation (resolved by pi-coding-agent), so secrets live in `.env`, not the committed config.
- `.env` feeds API keys into the container (see `.env.example`).
- `ripgrep`/`fd-find` are installed in the image; pi-coding-agent finds them on `PATH` (it probes both `fd` and Debian's `fdfind`). Don't commit prebuilt search binaries into `pi-config/agent/bin/`.
- User compose customizations are units too: catalog in `compose.d.available/`, enabled with `./config.d.sh enable compose <unit>`, which symlinks into the gitignored `compose.d/`. `run.sh` auto-layers every enabled `compose.d/*.yml` (sorted order) on top of the base `docker-compose.yml`. Point users there rather than editing the tracked compose file.

## Adding packages — the `*.d/` system

Heavy/optional tooling is **not** baked into the `Dockerfile`. Instead, `install-from-dir.sh` installs whatever is listed in the drop-in directories, applying files in filename-sort order:

- `apt.d/` → apt packages, `python.d/` → pip packages, `rust.d/` → cargo crates (bootstraps rustup on demand), `build.d/` → shell scripts (escape hatch for binary downloads, apt repos, etc.).
- One package per line, `#` comments. Apache-`a2enmod` style: units live in a **tracked** catalog `<type>.d.available/`; `config.d.sh` enables a unit by symlinking it into the live `<type>.d/` dir, which is gitignored except its `README.md`. `install-from-dir.sh` follows the symlinks (`find -L`).
- `config.d.sh` commands: `list [type]`, `enable <type> <unit>...`, `disable <type> <unit>...`, plus `--all [type]` to en/disable everything. Types come from the `*.d.available` dirs (apt/python/rust/build at build time, compose at run time).
- So: to add a package, drop a file in the relevant `*.d.available/` dir and `./config.d.sh enable <type> <file>` (or edit `install-from-dir.sh` / the `Dockerfile` core only if it's truly core). Don't hand-add `RUN apt-get install` lines to the `Dockerfile`, and don't put files directly in `*.d/` — they belong in `*.d.available/` and get symlinked in.

## Dockerfile layer strategy

The core apt layer is deliberately lean. The `*.d` install layers (`COPY <type>.d.available/` + `COPY <type>.d/` + `RUN …`, per ecosystem) sit **above** the daily `NPM_CACHEBUST` npm-install layer, so the daily CLI refresh never reinvalidates them (e.g. no TeX Live reinstall). Both the `.available` catalog and the `.d` enabled-symlinks dir are copied, so the relative symlinks resolve in-image. Each ecosystem is its own `COPY`/`RUN` group, so editing one package list only rebuilds that layer and the ones below it. Keep that ordering when editing the `Dockerfile`. A `.dockerignore` keeps the build context small (the `Dockerfile` only `COPY`s `install-from-dir.sh`, the four build-time `*.d`/`*.d.available` dir pairs, and `entrypoint.sh`; the compose dirs and `config.d.sh` are run-time only and excluded).

**Caching granularity is per-ecosystem, not per-unit.** A single `RUN` installs *all* enabled units of an ecosystem at once, so editing or enabling **any** apt unit invalidates the apt layer and reinstalls the entire apt set — including `texlive-full` (~5 GB). To stop that reinstall from re-*downloading*, the apt `RUN` uses **BuildKit cache mounts** (`--mount=type=cache` on `/var/cache/apt` and `/var/lib/apt`): the `.debs` and apt lists persist in the build cache, so the reinstall replays locally with no network fetch. This requires BuildKit (the docker/compose default; the `# syntax=docker/dockerfile:1` header opts in) — a non-BuildKit build still works but loses the cache. Two rules keep the cache effective: the apt `RUN` deletes `/etc/apt/apt.conf.d/docker-clean` (else the base image auto-purges `.debs` after install), and `install-from-dir.sh`'s apt branch must **not** `rm` the apt lists (it would wipe the mount). The mounted dirs aren't committed to the image, so the layer stays small regardless. `pip`/`cargo`/`build` layers have **no** cache mount yet, so editing those lists still re-downloads — add the same pattern (`/root/.cache/pip`, cargo registry/git) if that becomes painful.
