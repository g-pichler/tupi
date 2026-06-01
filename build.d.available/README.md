# build.d.available — build-script units (catalog)

Each file is a shell script run at image-build time when the unit is **enabled**
— the escape hatch for anything that isn't a plain apt/pip/cargo package (binary
downloads, third-party apt repos, multi-step installs). This dir is the catalog;
nothing here runs until enabled. Add your own units here too.

```
../config.d.sh list                 # show all units + state
../config.d.sh enable build 10_typst.sh
../config.d.sh disable build 10_typst.sh
```

Enabling symlinks the file into `../build.d/`; on the next image build,
`install-from-dir.sh` runs whatever is enabled, in filename-sort order. Rebuild
with `docker compose build` (or rerun `claude.sh`).
