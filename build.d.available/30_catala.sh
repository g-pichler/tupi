#!/usr/bin/env bash
# Catala (https://catala-lang.org) — the `catala` compiler + `clerk` build
# system. Upstream ships no stable prebuilt binaries (only nightly .debs), so
# this follows the official route: opam builds an OCaml switch + Catala from
# source. Slow (~15-20 min: compiles OCaml and all deps) and, like every build
# unit, redone whenever the build.d layer is invalidated.
#
# Same pattern as /opt/cargo and /opt/elan: the runtime agent runs as `node`
# remapped to an arbitrary host UID, so a per-HOME (/root) opam is useless.
# Instead the opam root lives in world-readable /opt/opam, and the switch's
# binaries (catala, clerk, plus ocaml/ocamlfind/dune for Catala's OCaml
# backend) are symlinked into /usr/local/bin. They find their libraries via
# compiled-in absolute paths, so no `opam env` is needed at runtime.
set -euo pipefail

OPAM_VERSION=2.5.2      # opam >= 2.2 required; Debian's apt opam is too old
OCAML_VERSION=4.14.2    # the book's recommended compiler (4.14 – 5.4 supported)
CATALA_VERSION=1.2.1

# OPAMROOTISOK: root is expected here (docker build), silence the warning.
export OPAMROOT=/opt/opam OPAMYES=1 OPAMCONFIRMLEVEL=unsafe-yes OPAMROOTISOK=1

case "$(dpkg --print-architecture)" in
  amd64) opam_arch=x86_64 ;;
  arm64) opam_arch=arm64 ;;
  *) echo "[catala] unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

# Build deps opam/OCaml/Catala need beyond the core image: ninja (clerk drives
# it at runtime too), gmp (zarith), m4/patch/unzip/bzip2 (opam + packages).
# The apt layer's lists live in a BuildKit cache mount, not the image, so
# refresh them here and drop them again to keep this layer small.
apt-get update
apt-get install -y --no-install-recommends \
  ninja-build libgmp-dev m4 patch unzip bzip2
rm -rf /var/lib/apt/lists/*

curl -fsSL "https://github.com/ocaml/opam/releases/download/${OPAM_VERSION}/opam-${OPAM_VERSION}-${opam_arch}-linux" \
  -o /usr/local/bin/opam
chmod +x /usr/local/bin/opam

# --disable-sandboxing: opam's bubblewrap sandbox can't run inside a docker
# build. -n: don't touch shell rc files; runtime PATH comes from the symlinks.
# The switch is named `default` explicitly (init --compiler would name it after
# the compiler) so the path below stays stable across OCaml bumps.
opam init --disable-sandboxing -n --bare
opam switch create default "ocaml-base-compiler.${OCAML_VERSION}"
opam install --switch=default "catala.${CATALA_VERSION}"
# Drop download caches, build dirs, and logs; they're only needed to rebuild.
opam clean --all-switches --download-cache --switch-cleanup --logs

# Expose the switch's binaries. Don't clobber anything another unit put in
# /usr/local/bin.
for b in "$OPAMROOT"/default/bin/*; do
  [ -f "$b" ] && [ -x "$b" ] || continue
  n="/usr/local/bin/$(basename "$b")"
  if [ -e "$n" ]; then
    echo "[catala] $n exists — not linking $(basename "$b")"
  else
    ln -s "$b" "$n"
  fi
done

# World-readable so any runtime UID can use it (entrypoint remaps node→HOST_UID).
chmod -R a+rX "$OPAMROOT"

catala --version
clerk --version
