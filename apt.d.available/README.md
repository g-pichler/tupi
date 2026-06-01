# apt.d.available — apt package units (catalog)

Each file lists Debian/apt packages (one per line, `#` for comments) installed
into the image when the unit is **enabled**. This dir is the catalog; nothing
here is installed until enabled. Add your own units here too.

```
../config.d.sh list                # show all units + state
../config.d.sh enable apt 00_texlive
../config.d.sh disable apt 00_texlive
```

Enabling symlinks the file into `../apt.d/`; on the next image build,
`install-from-dir.sh` installs whatever is enabled. Rebuild with
`docker compose build` (or just rerun `claude.sh` / `pi.sh`).
