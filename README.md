# pi sandbox

Docker-based dev container bundling the [`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Claude Code, and the Anthropic SDK on a lean core (Node, git, build tools, Python 3, ripgrep/fd). Heavier tooling — TeX Live, OCR, Rust, Typst, Soufflé, the scientific Python stack — is opt-in via drop-in package lists (see [Adding tools to the image](#adding-tools-to-the-image)). An optional GPU-backed Ollama service is wired up via `docker-compose`.

## Quick start

1. Copy `.env.example` to `.env` and fill in API keys you want to use:
   ```
   cp .env.example .env
   ```
2. Symlink the wrapper(s) into your `PATH`:
   ```
   ln -s "$(pwd)/run.sh"     ~/bin/claude.sh
   ln -s "$(pwd)/run.sh"     ~/bin/pi.sh
   ```
3. Run from any directory:
   ```
   claude.sh          # launches Claude Code in the current cwd
   pi.sh              # launches the pi coding agent
   claude.sh --shell  # drop into bash inside the container
   ```

The caller's `$(pwd)` is bind-mounted into the container at the same path and the container `cd`s into it, so relative paths Just Work. `~/.claude` and `~/.claude.json` are bind-mounted from the host, so memory, settings, and auth persist across runs and are shared with the host's Claude Code.

## Entry points

- `run.sh` — real dispatcher. Picks the agent based on `basename "$0"`: a name starting with `pi` runs the `pi` agent, anything else runs Claude Code with `--dangerously-skip-permissions`. `--shell` drops into bash instead.
- `claude.sh`, `pi.sh` — symlinks to `run.sh`. `run.sh` resolves its real location by walking the symlink chain by hand (no GNU `readlink -f`, so it works on macOS too) and finds the compose file next to it.

## Platform support

| Platform           | Status                                                      |
|--------------------|-------------------------------------------------------------|
| Linux              | ✅ native                                                   |
| macOS              | ✅ works (Docker Desktop or colima)                         |
| Windows + WSL2     | ✅ run the wrappers from inside a WSL2 distro               |
| Windows native     | ❌ bash wrappers won't run under cmd/PowerShell             |

A few host-side details that matter off Linux:

- **Bash.** `run.sh`/`entrypoint.sh` are bash scripts. macOS ships an old bash 3.2 but the scripts stay within it. On Windows use **WSL2** and run the wrappers inside the Linux distro — that path behaves exactly like Linux. Git Bash mostly works but mangles `$(pwd)` into `/c/...` paths that break Docker volume mounts, so WSL2 is the recommended route.
- **Bind-mounted config files must exist first.** The compose file mounts `~/.gitconfig`, `~/.claude.json`, and `~/.claude` from your host. If a file doesn't exist, Docker silently creates a *directory* in its place and the mount breaks. Pre-create them:
  ```
  touch ~/.gitconfig ~/.claude.json
  mkdir -p ~/.claude
  ```
- **File ownership.** `entrypoint.sh` remaps the container `node` user to your host UID/GID (`id -u`/`id -g`). On macOS Docker Desktop already translates ownership through its VM, so this is a harmless no-op; on Linux/WSL2 it's what keeps bind-mounted files owned by you.
- **Ollama / GPU.** The Ollama profile needs an NVIDIA GPU + nvidia-container-toolkit — Linux/WSL2 only. It's off by default, so macOS and GPU-less hosts run fine; point `OLLAMA_HOST` at a host-side or remote Ollama if you want models there.

## Optional services

### Ollama

Requires an NVIDIA GPU + nvidia-container-toolkit on the host. Not started by default, so the setup works on GPU-less machines out of the box.

```
docker compose --profile ollama up -d ollama
```

The `pi` service's `OLLAMA_HOST` defaults to `http://ollama:11434` and can be overridden via the environment (e.g. point at a host-side Ollama on another machine).

## Custom compose parts

You can add your own services, volumes, env vars, or ports without editing the tracked `docker-compose.yml`. Compose overrides are managed like everything else — as units in `compose.d.available/`, enabled with `./config.d.sh` (see [Adding tools](#adding-tools-to-the-image)):

```
./config.d.sh list compose             # show available overrides + state
./config.d.sh enable compose tea.yml   # symlink it into compose.d/
```

`run.sh` layers every enabled `compose.d/*.yml` on top of `docker-compose.yml`, in sorted order. Two units ship: `tea.yml` (mount the host `tea` CLI config) and `docker.yml` (host Docker access — see the warning below). To add your own, drop a `*.yml` into `compose.d.available/` and enable it.

Compose deep-merges these on top of the base file: scalar keys you set win, and list values (volumes, ports, list-form `environment`) are appended. For example, a unit giving the agent read-only SSH access plus a sidecar Postgres:

```yaml
# compose.d.available/extras.yml
services:
  pi:
    volumes:
      - ${HOME}/.ssh:/home/node/.ssh:ro
  postgres:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=devpassword
    ports:
      - "5432:5432"
```

### ⚠️ Host Docker access (opt-in)

The host Docker socket is **not** mounted by default. To let the agent drive the
host Docker daemon, enable the unit: `./config.d.sh enable compose docker.yml`.

> **Security warning.** Mounting `/var/run/docker.sock` gives the container full
> control of the host Docker daemon, which is **equivalent to root on the host**.
> Since the agent runs with `--dangerously-skip-permissions`, it (and any code it
> runs) could then start privileged containers, read the host filesystem, and
> escalate to root on your machine. Only enable this on a host you're willing to
> hand the agent root on — never on a shared or production machine.

## Configuring the pi agent

`pi-config/agent/settings.json` picks the default provider/model. Out of the box it defaults to `anthropic` / `claude-sonnet-4-6`, which uses the built-in Anthropic provider and reads `ANTHROPIC_API_KEY` from `.env` — set that key (see `.env.example`) and pi works with no further config.

`pi-config/agent/models.json` defines extra/custom providers. API keys there support `${ENV_VAR}` interpolation, so secrets stay in `.env` rather than the committed config. Two examples ship in it: `ollama` (local models, needs the Ollama service) and `aqueduct` (an OpenAI-compatible endpoint reading `${AQUEDUCT_API_KEY}`) — adapt or replace them, and point `defaultProvider` wherever you like.

## Adding tools to the image

The image ships a lean core (Node, git, build tools, Python 3, ripgrep/fd) plus
the agents. Everything heavier is opt-in via drop-in **units** — you enable
units, not edit the Dockerfile:

| Type     | Holds                          | Installed with                                |
|----------|--------------------------------|-----------------------------------------------|
| `apt`    | Debian package names           | `apt-get install`                             |
| `python` | Python package names           | `pip install`                                 |
| `rust`   | cargo crate names              | `cargo install` (bootstraps rustup on demand) |
| `build`  | shell scripts (escape hatch)   | run with `bash`                               |

It works Apache-`a2enmod` style. Units live in a tracked catalog,
`<type>.d.available/`; you **enable** the ones you want and `config.d.sh` symlinks
them into the live `<type>.d/` dir (gitignored, so your selection stays local):

```
./config.d.sh list                   # all units across all types + state
./config.d.sh enable apt 00_texlive  # turn one on   (--all turns on every unit)
./config.d.sh disable apt 00_texlive # turn it off   (--all [type] to clear)
```

Within a unit, one package name per line and `#` starts a comment; `build` units
are shell scripts (use them for anything a package manager can't express — binary
downloads, third-party apt repos — they run as root during the build). Units
apply in **filename-sort order** (e.g. `00_texlive` before `20_ocr`). The catalog
ships TeX Live, the OCR stack, the scientific Python set, and `build` scripts for
Soufflé, Typst, and the Gitea CLI; to add your own, drop a file in the relevant
`*.d.available/` and enable it.

Build-time units (apt/python/rust/build) take effect on the next image build —
rebuild with `docker compose build` (or just rerun `claude.sh`). Compose overrides
are units too, managed the same way (`./config.d.sh enable compose <unit>`); they
apply at run time. See [Custom compose parts](#custom-compose-parts).

The drop-in layers sit above the daily `npm` refresh layer, so picking up new
CLI versions never reinstalls heavy packages like TeX Live, and each ecosystem
is its own layer, so editing one list only rebuilds it and the layers below.

## Container layout

- `entrypoint.sh` reconciles UIDs: it remaps the baked-in `node` user (via `usermod`/`groupmod`) to `HOST_UID`/`HOST_GID` so files written to the bind mounts are owned by you on the host. Because a single user is reused, `HOME` is always `/home/node`, so host config (`.claude`, `.gitconfig`, …) is bind-mounted only there. If the Docker socket is mounted (opt-in — see [Host Docker access](#️-host-docker-access-opt-in)) it also joins that socket's group.
- `pi-config/agent` is bind-mounted to `/pi-config` and auto-`npm install`s any `extensions/*/package.json`.
- `.env` feeds API keys into the container (see `.env.example`).

## Rebuilding

Changes to `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, or the wrapper scripts only take effect on the **next** container run. Rebuild with:

```
docker compose build
```

or just rerun `claude.sh` / `pi.sh` — both pass `--build` to compose.

## License

MIT — see [LICENSE](LICENSE).
