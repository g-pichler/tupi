# python.d.available — pip package units (catalog)

Each file lists Python packages (one per line, `#` for comments) installed into
the image when the unit is **enabled**. This dir is the catalog; nothing here is
installed until enabled. Add your own units here too.

```
../config.d.sh list                  # show all units + state
../config.d.sh enable python scientific
../config.d.sh disable python scientific
```

Enabling symlinks the file into `../python.d/`; on the next image build,
`install-from-dir.sh` pip-installs whatever is enabled. Rebuild with
`docker compose build` (or just rerun `claude.sh` / `pi.sh`).
