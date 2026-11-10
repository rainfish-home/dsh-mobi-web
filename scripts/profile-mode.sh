#!/usr/bin/env bash
# Switch a DSH profile between the published package and this checkout.
#
# Why this exists: `link:` records an ABSOLUTE path in the profile. Moving the
# checkout silently dangles it, the bundle stops mounting, and the gateway port
# disappears with no error in the app log. This script makes the two modes
# explicit and verifies which one a profile is in.
#
# Usage:
#   scripts/profile-mode.sh status   [profile]              # default: desktop
#   scripts/profile-mode.sh registry [profile] [version]    # default: desktop 0.1.0
#   scripts/profile-mode.sh local    [profile]              # default: mobi-dev
#   scripts/profile-mode.sh restart                         # quit -> open -> wait for 3083
#
# The daily/phone profile should stay on `registry`. Use `local` only for a
# throwaway development profile (mobi-dev); linking `desktop` reintroduces the
# exact failure this script was written to clean up.
#
# `restart` quits the desktop app, so it kills any DSH session running inside
# it. Run it from Terminal, not from an agent conversation.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
APP_NAME=${DSH_APP_NAME:-DeepSeek Harness}
APP_PATH=${DSH_APP_PATH:-/Applications/DeepSeek Harness.app}
APP_BUNDLE_ID=${DSH_APP_BUNDLE_ID:-com.deepseek.dsh}
PKG=dsh-mobi-web
DEFAULT_PROFILE=desktop
DEV_PROFILE=mobi-dev
DEFAULT_VERSION=0.1.0

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

profile_dir() { printf '%s/profiles/%s' "$DSH_HOME" "$1"; }

require_profile() {
  local d
  d=$(profile_dir "$1")
  [ -f "$d/package.json" ] || die "no profile at $d"
  printf '%s' "$d"
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    "http://127.0.0.1:$1/__gw/health" 2>/dev/null || true
}

dep_spec() {
  python3 - "$1/package.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(p.get('dependencies', {}).get('dsh-mobi-web', '<absent>'))
PY
}

bundle_list() {
  python3 - "$1/package.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(','.join(p.get('dsh', {}).get('profile', {}).get('bundles', [])))
PY
}

installed_version() {
  python3 - "$1/node_modules/dsh-mobi-web/package.json" 2>/dev/null <<'PY' || echo '?'
import json, sys
print(json.load(open(sys.argv[1]))['version'])
PY
}

installed_kind() {
  local entry="$1/node_modules/$PKG"
  if [ -L "$entry" ]; then
    if [ -e "$entry" ]; then printf 'symlink -> %s (valid)' "$(readlink "$entry")"
    else printf 'symlink -> %s (DANGLING)' "$(readlink "$entry")"
    fi
  elif [ -d "$entry" ]; then printf 'installed directory (copy)'
  else printf 'missing'
  fi
}

status() {
  local p=${1:-$DEFAULT_PROFILE} d
  d=$(require_profile "$p")
  say "profile:   $d"
  say "spec:      $(dep_spec "$d")"
  say "installed: $(installed_version "$d") — $(installed_kind "$d")"
  say "bundles:   $(bundle_list "$d")"
  say "health:    3083=$(http_code 3083)  3183=$(http_code 3183)"
  say "app:       $(app_running && echo running || echo not-running) ($APP_PATH)"
}

verify() {
  local p=$1 d spec
  d=$(profile_dir "$p")
  spec=$(dep_spec "$d")
  case "$spec" in
    link:*)
      [ -e "$d/node_modules/$PKG" ] || die "the link target does not exist: ${spec#link:}"
      ;;
    [0-9]*)
      [ -d "$d/node_modules/$PKG" ] && [ ! -L "$d/node_modules/$PKG" ] ||
        die "expected an installed copy, got: $(installed_kind "$d")"
      ;;
    *)
      die "unexpected dependency spec for $PKG: $spec"
      ;;
  esac
  grep -q '"dsh-mobi-web"' "$d/package.json" || die "$PKG missing from $d/package.json"
  status "$p"
}

backup() {
  local d=$1 b
  b="$d/.profile-mode-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$b"
  chmod 700 "$b"
  cp -p "$d/package.json" "$d/pnpm-lock.yaml" "$b/" 2>/dev/null || cp -p "$d/package.json" "$b/"
  say "backup: $b"
}

switch_registry() {
  local p=${1:-$DEFAULT_PROFILE} v=${2:-$DEFAULT_VERSION} d
  command -v dsh >/dev/null || die "dsh is not on PATH (expected ~/.local/bin/dsh)"
  d=$(require_profile "$p")
  backup "$d"
  say "installing $PKG@$v into $p (registry copy)…"
  dsh plugin --profile "$p" add "$PKG@$v"
  verify "$p"
}

switch_local() {
  local p=${1:-$DEV_PROFILE} d
  command -v dsh >/dev/null || die "dsh is not on PATH (expected ~/.local/bin/dsh)"
  d=$(require_profile "$p")
  if [ "$p" = "$DEFAULT_PROFILE" ]; then
    say "warning: linking '$DEFAULT_PROFILE' makes the daily gateway depend on this checkout's absolute path."
    say "         prefer: scripts/profile-mode.sh local $DEV_PROFILE"
  fi
  backup "$d"
  say "linking $p -> $REPO_ROOT"
  dsh plugin --profile "$p" add "link:$REPO_ROOT"
  verify "$p"
}

app_running() {
  # The gateway port closes when the plugin disposes, which is a few seconds
  # BEFORE the app process exits. The port is therefore not a reliable "app is
  # gone" signal: opening at port=000 re-activates the dying instance, it exits,
  # and nothing is left running. Ask LaunchServices about the application.
  [ "$(osascript -e "application \"$APP_NAME\" is running" 2>/dev/null)" = 'true' ]
}

launch_app() {
  # Full bundle path first: a stale LaunchServices name entry can turn
  # `open -a` into a silent no-op.
  open "$APP_PATH" >/dev/null 2>&1 && return 0
  open -b "$APP_BUNDLE_ID" >/dev/null 2>&1 && return 0
  open -a "$APP_NAME" >/dev/null 2>&1 && return 0
  return 1
}

restart() {
  local code attempt
  # A false negative here would turn the restart into a no-op: `open` would
  # activate the running app and the 3083 check would pass without a restart.
  if ! app_running && [ "$(http_code 3083)" = '200' ]; then
    say "error: 3083 is serving but AppleScript says $APP_NAME is not running."
    say "       Quit it by hand, then rerun: scripts/profile-mode.sh restart"
    return 1
  fi

  if app_running; then
    say "quitting $APP_NAME (this ends any session running inside it)…"
    if ! osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1; then
      say "error: could not ask $APP_NAME to quit (Automation permission?)."
      say "       quit it by hand, then rerun: scripts/profile-mode.sh restart"
      return 1
    fi
    for _ in $(seq 1 60); do
      app_running || break
      sleep 1
    done
    if app_running; then
      say "error: $APP_NAME is still running after 60 s (a dialog may be open)."
      say "       quit it by hand, then rerun: scripts/profile-mode.sh restart"
      return 1
    fi
  else
    say "$APP_NAME is not running; launching it"
  fi

  say "opening ${APP_NAME}…"
  if ! launch_app; then
    say "error: could not launch $APP_PATH"
    say "       open it by hand: open \"$APP_PATH\""
    return 1
  fi

  for attempt in $(seq 1 90); do
    code=$(http_code 3083)
    if [ "$code" = '200' ]; then
      say "gateway is up on 127.0.0.1:3083"
      return 0
    fi
    # A launch can still be lost while the old instance tears down. If the app
    # is no longer running, launch again instead of waiting out the timeout.
    if [ $((attempt % 5)) -eq 0 ] && ! app_running; then
      say "app is not running yet — retrying launch ($((attempt / 5)))"
      launch_app || true
    fi
    sleep 2
  done
  say "gateway did not answer on 3083 within 180 s."
  say "Check: scripts/profile-mode.sh status desktop"
  say "If the app is open without the gateway, quit and reopen it by hand:"
  say "  open \"$APP_PATH\""
  return 1
}

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

cmd=${1:-status}
[ $# -gt 0 ] && shift || true
case "$cmd" in
  status)   status "${1:-$DEFAULT_PROFILE}" ;;
  registry) switch_registry "${1:-$DEFAULT_PROFILE}" "${2:-$DEFAULT_VERSION}" ;;
  local)    switch_local "${1:-$DEV_PROFILE}" ;;
  restart)  restart ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
