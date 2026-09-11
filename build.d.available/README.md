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
`/opt/texlive` — a versionable replacement for the Debian `apt 00_texlive` unit
(which lags years behind). Edit `TEXLIVE_YEAR`/`TEXLIVE_SCHEME`/`TEXLIVE_MIRROR`
at its top to configure release/scheme/mirror. It is NOT run by the generic
build.d loop: the Dockerfile runs it in its own multi-stage image so the ~5 GB
install is cached independently and immune to npm/apt/python/rust/other-build
changes — only editing this file rebuilds it. It's an *alternative* to the apt
unit: keep `apt 00_texlive` disabled.

Enabling symlinks the file into `../build.d/`; on the next image build,
`install-from-dir.sh` runs whatever is enabled, in filename-sort order. Rebuild
with `docker compose build` (or rerun `claude.sh`).
