# build.d.available — build-script units (catalog)

Each file is a shell script run at image-build time when the unit is **enabled**
— the escape hatch for anything that isn't a plain apt/pip/cargo package (binary
downloads, third-party apt repos, multi-step installs). This dir is the catalog;
nothing here runs until enabled. Add your own units here too.

```
../config.d.sh list                 # show all units + state
../config.d.sh enable build 10_typst.sh
../config.d.sh enable build 50_texlive.sh   # upstream TeX Live (versionable)
../config.d.sh disable build 10_typst.sh
```

`50_texlive.sh` installs the current upstream TeX Live from tug.org into
`/opt/texlive`. It's an alternative to the Debian `apt 00_texlive` unit, which
lags years behind, so enable one or the other, not both. Set the scheme and
mirror (the mirror determines the release) with the variables at the top of the
script. Enabling it works like any other unit, but it skips the regular build
loop. The Dockerfile installs it in a dedicated stage instead, so the multi-GB
download is cached separately and survives npm/apt/python/rust/other-build
changes. Only editing the script rebuilds it.

Enabling symlinks the file into `../build.d/`; on the next image build,
`install-from-dir.sh` runs whatever is enabled, in filename-sort order. Rebuild
with `docker compose build` (or rerun `claude.sh`).
