# apt.d — enabled apt units

Symlinks here point into `../apt.d.available/` and mark which apt package lists
get installed into the image. Manage them with `../config.d.sh` — don't edit by
hand:

```
../config.d.sh enable apt 00_texlive
../config.d.sh disable apt 00_texlive
../config.d.sh list apt
```

This dir is gitignored except this README, so what you enable stays local to
your checkout. After changes, rebuild: `docker compose build` (or rerun
`claude.sh` / `pi.sh`).
