#!/usr/bin/env bash
# config.d.sh — enable/disable drop-in units, Apache a2enmod style.
#
# Units live in <type>.d.available/ (tracked catalog). Enabling a unit creates a
# symlink to it in <type>.d/; disabling removes that symlink. The <type>.d/ dirs
# are gitignored, so what you enable stays local to your checkout.
#
# Types are discovered from the *.d.available directories: apt, python, rust,
# build (installed into the image at build time) and compose (compose overrides
# layered in at run time by run.sh).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

usage() {
  cat <<'EOF'
Usage: config.d.sh <command> [args]

  list [type]                  Show units and their enabled/disabled state.
  enable  <type> <unit>...     Enable one or more units.
  disable <type> <unit>...     Disable one or more units.
  enable  --all [type]         Enable every unit (optionally just one type).
  disable --all [type]         Disable every unit (optionally just one type).

Types: apt, python, rust, build, compose (whatever *.d.available dirs exist).

Build-time units (apt/python/rust/build) take effect on the next image build:
  docker compose build      (or just rerun claude.sh / pi.sh)
compose units take effect on the next claude.sh / pi.sh run.
EOF
}

all_types() {
  for d in *.d.available; do
    [ -d "$d" ] && echo "${d%.d.available}"
  done
}

valid_type() {
  local t
  for t in $(all_types); do [ "$t" = "$1" ] && return 0; done
  echo "unknown type: $1 (have: $(all_types | paste -sd' '))" >&2
  return 1
}

# Units of a type: files in <type>.d.available/ except README.md.
units_of() {
  find "$1.d.available" -maxdepth 1 -type f ! -name 'README.md' -printf '%f\n' \
    2>/dev/null | sort
}

enable_one() {
  local t=$1 u=$2
  [ -e "$t.d.available/$u" ] || { echo "no such unit: $t/$u" >&2; return 1; }
  mkdir -p "$t.d"
  ln -sfn "../$t.d.available/$u" "$t.d/$u"
  echo "enabled  $t/$u"
}

disable_one() {
  local t=$1 u=$2
  if [ -L "$t.d/$u" ]; then
    rm "$t.d/$u"; echo "disabled $t/$u"
  elif [ -e "$t.d/$u" ]; then
    echo "skip $t/$u: not a symlink, leaving as-is" >&2
  else
    echo "already disabled: $t/$u" >&2
  fi
}

cmd_list() {
  local types u mark
  types=$([ $# -gt 0 ] && { valid_type "$1" && echo "$1"; } || all_types)
  for t in $types; do
    echo "[$t]"
    while read -r u; do
      [ -z "$u" ] && continue
      [ -L "$t.d/$u" ] && mark="x" || mark=" "
      printf "  [%s] %s\n" "$mark" "$u"
    done < <(units_of "$t")
  done
}

# apply <enable|disable> <args...>
apply() {
  local action=$1; shift
  local fn="${action}_one"

  if [ "${1:-}" = "--all" ]; then
    shift
    local types
    if [ $# -gt 0 ]; then valid_type "$1"; types=$1; else types=$(all_types); fi
    for t in $types; do
      while read -r u; do [ -n "$u" ] && "$fn" "$t" "$u"; done < <(units_of "$t")
    done
    return
  fi

  [ $# -ge 2 ] || { echo "usage: config.d.sh $action <type> <unit>..." >&2; exit 1; }
  local t=$1; shift; valid_type "$t"
  for u in "$@"; do "$fn" "$t" "$u"; done
}

case "${1:-}" in
  list)            shift; cmd_list "$@" ;;
  enable|disable)  action=$1; shift; apply "$action" "$@" ;;
  ""|-h|--help)    usage ;;
  *)               echo "unknown command: $1" >&2; usage >&2; exit 1 ;;
esac
