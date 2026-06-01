# python.d — enabled pip units

Symlinks here point into `../python.d.available/` and mark which pip package
lists get installed into the image. Manage them with `../config.d.sh` — don't
edit by hand:

```
../config.d.sh enable python scientific
../config.d.sh disable python scientific
../config.d.sh list python
```

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
