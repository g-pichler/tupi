#!/usr/bin/env bash
#
# Upstream TeX Live (current release) — replaces the Debian texlive-full apt
# unit, which always lags years behind (bookworm ships TeX Live 2022 + biber
# 2.18 forever). Installing straight from https://tug.org/texlive gives the
# current year's matching toolset (pdflatex + biber + biblatex stay
# version-consistent, e.g. TeX Live 2026 -> biber 2.21, pdfTeX 1.40.29).
#
# This runs in a DEDICATED multi-stage image (see Dockerfile `FROM ... AS
# texlive`), NOT the generic build.d run, so its multi-GB install is downloaded
# once and cached forever — no other change (npm bump, apt/python/rust edits,
# other build.d scripts) invalidates it. The Dockerfile then COPYs /opt/texlive
# into the main image and symlinks its binaries into /usr/local/bin.
#
# It's an *alternative* to the distro `apt 00_texlive` unit: leave that unit
# disabled so the upstream install is the one that wins (the Dockerfile symlinks
# on /usr/local/bin precede /usr/bin anyway).
#
# CONFIGURABLE — edit these in this file (tracked catalog), then rebuild:
#   TEXLIVE_YEAR     release tag/install dir. Defaults to the current tlnet
#                    release (autodetected from the install-tl tarball date);
#                    pin it to e.g. 2025 if you want a specific release.
#   TEXLIVE_SCHEME   what to install: scheme-full (default, multi-GB but the
#                    apt texlive-full equivalent), or a leaner scheme
#                    (scheme-basic, scheme-medium) — biber + pdflatex + a
#                    LaTeX engine ride along on all of them.
#   TEXLIVE_MIRROR   any CTAN/texlive mirror hosting .../systems/texlive/tlnet.
# For arbitrary per-package pins after install (e.g. a specific biber), run
# `tlmgr install <pkg>@<rev>` / `tlmgr update --all` in the shell and they
# persist because /opt/texlive isn't a Docker volume.
#
# Mirrors the /opt/cargo + /opt/elan pattern: installs into world-readable
# /opt/texlive (chmod a+rX so any runtime UID — including the `node` user
# remapped to an arbitrary HOST_UID by entrypoint.sh — can use it). The
# Dockerfile handles PATH exposure via /usr/local/bin symlinks.
set -euo pipefail

TEXLIVE_YEAR="${TEXLIVE_YEAR:-}"
TEXLIVE_SCHEME="${TEXLIVE_SCHEME:-scheme-full}"
TEXLIVE_MIRROR="${TEXLIVE_MIRROR:-https://mirror.ctan.org/systems/texlive/tlnet}"
TEXLIVE_ROOT="${TEXLIVE_ROOT:-/opt/texlive}"
TEXLIVE_FORCE="${TEXLIVE_FORCE:-0}"

# TeX Live's platform name; matches dpkg arch for the two we target.
case "$(dpkg --print-architecture)" in
  amd64) TL_ARCH="x86_64-linux" ;;
  arm64) TL_ARCH="aarch64-linux" ;;
  *) echo "[texlive] unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac


url="${TEXLIVE_MIRROR%/}/install-tl-unx.tar.gz"
tmp="$(mktemp -d /tmp/texlive-install.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

echo "[texlive] importing release from $url"
curl -fsSL "$url" -o "$tmp/install-tl.tar.gz"
tar -xzf "$tmp/install-tl.tar.gz" -C "$tmp"

# Derive the release year from the tarball dir (install-tl-YYYYMMDD) unless
# pinned. install-tl always tracks the current tlnet release, so this matches
# the mirror you're pulling from.
if [ -z "$TEXLIVE_YEAR" ]; then
  dir="$(ls -d "$tmp"/install-tl-*)"
  TEXLIVE_YEAR="$(basename "$dir" | sed -E 's/^install-tl-([0-9]{4}).*/\1/')"
fi
echo "[texlive] release $TEXLIVE_YEAR, scheme $TEXLIVE_SCHEME"

texdir="$TEXLIVE_ROOT/$TEXLIVE_YEAR"
if [ -x "$texdir/bin/"*/*/pdflatex ] && [ "$TEXLIVE_FORCE" != 1 ]; then
  echo "[texlive] $texdir already installed (TEXLIVE_FORCE!=1) — skipping"
  exit 0
fi

# Notes: runs in its own dedicated stage, so there's no Debian texlive to purge
# here. Docs/srcfiles off (multi-GB, rarely wanted in a container). adjustpath
# off: the Dockerfile symlinks TeX Live into /usr/local/bin for PATH.
cat > "$tmp/texlive.profile" <<EOF
selected_scheme $TEXLIVE_SCHEME
TEXDIR $texdir
TEXMFLOCAL $TEXLIVE_ROOT/texmf-local
TEXMFSYSCONFIG $texdir/texmf-config
TEXMFSYSVAR $texdir/texmf-var
TEXMFHOME ~/texmf
TEXMFVAR ~/.texlive$TEXLIVE_YEAR/texmf-var
TEXMFCONFIG ~/.texlive$TEXLIVE_YEAR/texmf-config
binary_$TL_ARCH 1
tlpdbopt_autobackup 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
instopt_adjustpath 0
instopt_adjustrepo 0
EOF
"$tmp"/install-tl-*/install-tl -no-gui -repository "$TEXLIVE_MIRROR" \
  -profile "$tmp/texlive.profile"

# World-readable so any runtime UID can use it (entrypoint remaps node->HOST_UID).
chmod -R a+rX "$TEXLIVE_ROOT"

echo "[texlive] done:"
"$texdir"/bin/*/pdflatex --version | head -2
if [ -x "$texdir"/bin/*/biber ]; then
  "$texdir"/bin/*/biber --version
else
  echo "[texlive] (no biber in scheme $TEXLIVE_SCHEME — it's not in leaner schemes like scheme-basic)"
fi
