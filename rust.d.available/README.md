# rust.d.available — cargo crate units (catalog)

Each file lists Rust crates (one per line, `#` for comments) installed via
`cargo install` when the unit is **enabled**. This dir is the catalog; nothing
here is installed until enabled. Add your own units here too.

```
../config.d.sh list                # show all units + state
../config.d.sh enable rust tools
../config.d.sh disable rust tools
```

Enabling symlinks the file into `../rust.d/`; on the next image build,
`install-from-dir.sh` installs whatever is enabled (bootstrapping rustup on
demand). Rebuild with `docker compose build` (or rerun `claude.sh` / `pi.sh`).
