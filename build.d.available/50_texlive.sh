#!/usr/bin/env bash
#
# Upstream TeX Live (current release) — an alternative to the Debian
# texlive-full apt unit, which lags years behind (bookworm ships TeX Live 2022
# + biber 2.18 forever). Installing straight from https://tug.org/texlive gives
# a current, self-consistent toolset (pdflatex, biber, and biblatex versions
# all match).
#
# Enable like any build unit (`./config.d.sh enable build 50_texlive.sh`), but
# it does NOT run in the generic build.d loop (the Dockerfile passes
# INSTALL_SKIP=50_texlive.sh there). The Dockerfile runs it in a dedicated
# stage (`FROM ... AS texlive`), so the multi-GB install is downloaded once and
# cached: no other change (npm bump, apt/python/rust edits, other build.d
# units) invalidates it. The main image then COPYs /opt/texlive in and symlinks
# its binaries into /usr/local/bin. Disabled, the stage is an empty no-op.
#
# Enable this OR the distro `apt 00_texlive` unit, not both (with both, these
# /usr/local/bin symlinks shadow the /usr/bin ones anyway).
#
# CONFIGURABLE: edit the defaults below, then rebuild. Editing this file
# rebuilds (re-downloads) TeX Live; nothing else does.
#   TEXLIVE_SCHEME   what to install: scheme-full (default, multi-GB, the
#                    texlive-full equivalent) or a leaner scheme (scheme-medium,
#                    scheme-basic). pdflatex comes with all of them; biber
#                    only with schemes that include collection-bibtexextra
#                    (scheme-full does, scheme-basic doesn't).
#   TEXLIVE_MIRROR   tlnet repository to install from. The default serves the
#                    current release. For a past release, point it at that
#                    year's frozen repo, e.g.
#                    https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final
#   TEXLIVE_YEAR     install dir name under /opt/texlive. Leave empty to use
#                    the release year the mirror reports. This does NOT pick
#                    the release; TEXLIVE_MIRROR does.
# Runtime `tlmgr` changes don't stick: /opt/texlive is root-owned and every
# container is `run --rm`. To add or update packages, append `tlmgr` commands
# at the end of this script and rebuild.
#
# Same pattern as /opt/cargo and /opt/elan: installs into world-readable
# /opt/texlive (chmod a+rX so any runtime UID, including the `node` user
# remapped to HOST_UID by entrypoint.sh, can use it).
set -euo pipefail

TEXLIVE_YEAR="${TEXLIVE_YEAR:-}"
TEXLIVE_SCHEME="${TEXLIVE_SCHEME:-scheme-full}"
TEXLIVE_MIRROR="${TEXLIVE_MIRROR:-https://mirror.ctan.org/systems/texlive/tlnet}"
TEXLIVE_ROOT="${TEXLIVE_ROOT:-/opt/texlive}"

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

# Take the release year from install-tl's own release file ("TeX Live (...)
# version YYYY") unless set. The tarball's date suffix (install-tl-YYYYMMDD)
# isn't reliable: a January build still ships the previous year's release.
if [ -z "$TEXLIVE_YEAR" ]; then
  TEXLIVE_YEAR="$(sed -nE '1s/.*version ([0-9]{4}).*/\1/p' \
    "$tmp"/install-tl-*/release-texlive.txt)"
  [ -n "$TEXLIVE_YEAR" ] || { echo "[texlive] can't detect release year" >&2; exit 1; }
fi
echo "[texlive] release $TEXLIVE_YEAR, scheme $TEXLIVE_SCHEME"

texdir="$TEXLIVE_ROOT/$TEXLIVE_YEAR"

# Docs/srcfiles off (multi-GB, rarely wanted in a container). adjustpath off:
# the Dockerfile symlinks TeX Live into /usr/local/bin for PATH.
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
