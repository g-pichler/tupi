# compose.d.available — Docker Compose override units (catalog)

Each `*.yml` here is a [Compose override](https://docs.docker.com/compose/multiple-compose-files/merge/)
layered on top of the tracked `docker-compose.yml` when the unit is **enabled**.
Unlike the apt/python/rust/build units (which apply at image-build time), compose
units apply at **run time** — `run.sh` merges every enabled `compose.d/*.yml`.

```
../config.d.sh list                    # show all units + state
../config.d.sh enable compose tea.yml
../config.d.sh disable compose tea.yml
```

Enabling symlinks the file into `../compose.d/`. Compose deep-merges these:
scalar keys you set win, list values (volumes, ports, list-form `environment`)
are appended. Changes take effect on the next `claude.sh` / `pi.sh` run.

## Units

- `tea.yml` — mount the host `~/.config/tea` dir so the in-container
  [tea](https://gitea.com/gitea/tea) CLI reuses your Gitea/Forgejo logins.
- `docker.yml` — mount the host Docker socket so the agent can drive the host
  Docker daemon. **⚠️ Grants root-on-host — read the warning in the file first.**
