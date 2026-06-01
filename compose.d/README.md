# compose.d — enabled Compose override units

Symlinks here point into `../compose.d.available/` and mark which Compose
overrides `run.sh` layers on top of `docker-compose.yml` at run time. Manage them
with `../config.d.sh` — don't edit by hand:

```
../config.d.sh enable compose tea.yml
../config.d.sh disable compose tea.yml
../config.d.sh list compose
```

This dir is gitignored except this README, so what you enable stays local to
your checkout. Changes take effect on the next `claude.sh` / `pi.sh` run.
