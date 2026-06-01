# build.d — enabled build-script units

Symlinks here point into `../build.d.available/` and mark which build scripts run
at image-build time. Manage them with `../config.d.sh` — don't edit by hand:

```
../config.d.sh enable build 10_typst.sh
../config.d.sh disable build 10_typst.sh
../config.d.sh list build
```

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
