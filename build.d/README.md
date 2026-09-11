# build.d — enabled build-script units

Symlinks here point into `../build.d.available/` and mark which build scripts run
at image-build time. Manage them with `../config.d.sh` — don't edit by hand:

```
../config.d.sh enable build 10_typst.sh
../config.d.sh disable build 10_typst.sh
../config.d.sh list build
```

Note: `50_texlive.sh` is an exception — it is enabled'ed here into the run loop,
but the Dockerfile builds it in its own dedicated stage for cache isolation (see
`build.d.available/README.md`), so don't enable it via this dir.

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
