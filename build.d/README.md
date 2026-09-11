# build.d — enabled build-script units

Symlinks here point into `../build.d.available/` and mark which build scripts run
at image-build time. Manage them with `../config.d.sh` — don't edit by hand:

```
../config.d.sh enable build 10_typst.sh
../config.d.sh disable build 10_typst.sh
../config.d.sh list build
```

`50_texlive.sh` is enabled here like any other unit, but it doesn't run in the
regular build loop. The Dockerfile installs it in a dedicated stage so its
multi-GB download is cached separately (see `build.d.available/README.md`).

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
