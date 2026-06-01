# rust.d — enabled cargo units

Symlinks here point into `../rust.d.available/` and mark which cargo crates get
installed into the image. Manage them with `../config.d.sh` — don't edit by
hand:

```
../config.d.sh enable rust tools
../config.d.sh disable rust tools
../config.d.sh list rust
```

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
