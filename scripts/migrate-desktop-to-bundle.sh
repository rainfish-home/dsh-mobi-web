#!/usr/bin/env bash
# Migrate the Desktop profile from the hand-rolled gateway row to the bundle row.
#
# Why this is a script and not a few commands: the row swap has to happen while
# the app is stopped. Editing cordis.patch.yml while the app runs makes the
# live patch layer reload and disposes the old gateway, so the phone loses
# access until the restart — and whoever restarts the app kills the session
# that would have done the edit. This does quit -> edit -> relaunch in one go,
# from a terminal, so the dead window is a few seconds.
#
# Usage:
#   scripts/migrate-desktop-to-bundle.sh --dry-run   # print what would change
#   scripts/migrate-desktop-to-bundle.sh             # do it
#
# Preconditions (both already true on this machine):
#   * `dsh plugin --profile desktop add link:<repo>` has run, so package.json's
#     dsh.profile.bundles lists dsh-mobi-web
#   * $DSH_HOME/dsh-mobi-web-token holds the password the phone already knows
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
TOKEN_FILE="${DSH_HOME:-$HOME/.dsh}/dsh-mobi-web-token"
APP_NAME="${DSH_APP_NAME:-DeepSeek Harness}"
PATCH="$PROFILE/cordis.patch.yml"
GUARD_DIR="$PROFILE/patch-guard/blocks"
OLD_MARKER='# ---- mobile gateway (self-hosted)'
DRY_RUN=0
[ "${1:-}" = '--dry-run' ] && DRY_RUN=1

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$PATCH" ] || die "no $PATCH"
grep -q '"dsh-mobi-web"' "$PROFILE/package.json" 2>/dev/null ||
  die "dsh-mobi-web is not in $PROFILE/package.json — run: dsh plugin --profile desktop add link:$PWD"
[ -f "$TOKEN_FILE" ] || say "warning: $TOKEN_FILE is missing; the plugin will mint a NEW password that the phone does not know"
grep -qF "$OLD_MARKER" "$PATCH" || { say "already migrated: no hand-rolled gateway row in $PATCH"; exit 0; }
grep -q 'id: mobile-gateway' "$PATCH" || die "the marker is there but no mobile-gateway row — inspect $PATCH by hand"

# The row being replaced has to be the last block: the surgery truncates there.
tail_after_marker=$(sed -n "/${OLD_MARKER//\//\\/}/,\$p" "$PATCH")
[ "$(printf '%s\n' "$tail_after_marker" | grep -c '^ *- *id:')" -eq 1 ] ||
  die "the gateway block is not the last block in $PATCH — migrate by hand"

backup="$PROFILE/.bundle-migration-$(date +%Y%m%d-%H%M%S)"

rewrite_patch() {
  local path="$1"
  python3 - "$path" "$OLD_MARKER" <<'PY'
import pathlib, sys
path, marker = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
i = text.find(marker)
if i < 0:
    sys.exit('marker not found')
block = """
# ---- dsh-mobi-web (bundle) ------------------------------------------------
# The gateway is a bundle row now (package.json -> dsh.profile.bundles), so
# nothing is inserted here. Only the local config that differs from the bundle
# is restated: a patch replaces the row's whole config object, so the port the
# bundle sets (3083) would fall back to the code default 3080. The password is
# not in this file any more — it lives in
# $DSH_HOME/dsh-mobi-web-token (mode 0600).
- id: dsh-mobi-web
  name: dsh-mobi-web
  config:
    listenHost: '127.0.0.1'
    listenPort: 3083
    blockPaths: ['/dsh-whale/']
"""
path.write_text(text[:i].rstrip('\n') + '\n' + block)
PY
}

# The guard restores any block whose marker is missing, and it matches the row
# id by substring — so it would resurrect the row we are removing. Repoint it
# at the new override row BEFORE the patch is touched.
point_guard_at_new_block() {
  [ -d "$GUARD_DIR" ] || { say "no guard blocks dir; skipping guard update"; return 0; }
  cat > "$GUARD_DIR/dsh-mobi-web.yml" <<'YML'
# guard-id: dsh-mobi-web
# ---- dsh-mobi-web (bundle) ------------------------------------------------
# Restored by the launchd guard if the app rewrites cordis.patch.yml.
# The gateway row itself is a bundle and cannot be dropped this way; only this
# config override (port + blockPaths) lives in the profile patch layer.
- id: dsh-mobi-web
  name: dsh-mobi-web
  config:
    listenHost: '127.0.0.1'
    listenPort: 3083
    blockPaths: ['/dsh-whale/']
YML
  rm -f "$GUARD_DIR/mobile-gateway.yml"
  say "guard: repointed to dsh-mobi-web.yml, old block removed"
}

if [ "$DRY_RUN" = 1 ]; then
  tmp="$(mktemp -t dsh-mobi-web-dry-run)"
  cp "$PATCH" "$tmp"
  rewrite_patch "$tmp"
  say '--- resulting user layer (diff) ---'
  diff -u "$PATCH" "$tmp" || true
  rm -f "$tmp"
  say '--- dry run only: nothing else changed ---'
  exit 0
fi

mkdir -p "$backup" && chmod 700 "$backup"
cp "$PATCH" "$backup/cordis.patch.yml"
chmod 600 "$backup/cordis.patch.yml"   # it still contains the password
[ -f "$GUARD_DIR/mobile-gateway.yml" ] && cp "$GUARD_DIR/mobile-gateway.yml" "$backup/guard-block-mobile-gateway.yml"
say "backup: $backup"

# Quit before editing: the running app still serves 3083 from the old row.
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 ||
  die "could not ask $APP_NAME to quit — quit it by hand, then re-run"
for _ in $(seq 1 30); do
  pgrep -f "$APP_NAME" >/dev/null || break
  sleep 1
done
pgrep -f "$APP_NAME" >/dev/null && die "$APP_NAME did not exit; nothing was changed"

point_guard_at_new_block
rewrite_patch "$PATCH"
say "patched: $PATCH"

open -a "$APP_NAME" || die "could not relaunch $APP_NAME — start it by hand"

for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3083/__gw/health || true)
  if [ "$code" = '200' ]; then
    say "gateway is up on 127.0.0.1:3083 (health 200)"
    say
    say 'Done. The phone has to log in once more: the cookie signature domain'
    say "changed with the rename. The password is unchanged — it is in $TOKEN_FILE"
    say 'Rollback: quit the app, restore the files from the backup above, and'
    say "re-run: launchctl kickstart -k gui/$(id -u)/com.dsh.patch-guard"
    exit 0
  fi
  sleep 2
done

say "gateway did not answer on 3083 within 120 s — check the app's plugin log."
say "Rollback: quit the app, copy $backup/cordis.patch.yml over $PATCH, restore"
say "the guard block, then start the app again."
exit 1
