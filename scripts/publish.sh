#!/usr/bin/env bash
# Publish this checkout to npmjs.com.
#
#   scripts/publish.sh                 # clean tree required; no git tag
#   scripts/publish.sh --allow-dirty   # publish the working tree as-is (no tag)
#   scripts/publish.sh --tag           # clean tree; publish, tag vX.Y.Z, push,
#                                       # and create a GitHub release if gh is ready
#   scripts/publish.sh --tag-only      # npm is already published: push the branch,
#                                       # tag vX.Y.Z, and create the GitHub release
#   scripts/publish.sh --dry-run       # run every check, stop before npm publish
#
# The script stops before publishing if the tests fail, if the shipped files
# contain this machine's token/hostname, or if the version is already on npm.
# npm login (and 2FA) is interactive: run `npm login` first if the script says
# the registry rejected the current token.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

CACHE=${NPM_CACHE:-/tmp/npm-cache}
ALLOW_DIRTY=0
TAG=0
TAG_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --tag) TAG=1 ;;
    --tag-only) TAG=1; TAG_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

say "package: $PKG@$VERSION"

finish_release() {
  if [ "$TAG" -ne 1 ]; then
    say ""
    say "next (optional): git push origin HEAD && git tag v$VERSION && git push origin v$VERSION"
    return
  fi

  # A pushed tag does not move the branch: without this, the release commit
  # never appears on origin/main (the 0.1.2 failure).
  git push origin HEAD
  say "pushed $(git rev-parse --abbrev-ref HEAD) to origin"

  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    local tagged
    tagged=$(git rev-list -n 1 "v$VERSION")
    if [ "$tagged" != "$(git rev-parse HEAD)" ]; then
      die "tag v$VERSION points to $tagged, not HEAD ($(git rev-parse HEAD)); refusing to move it"
    fi
    say "tag v$VERSION already exists locally"
  else
    git tag "v$VERSION"
    say "tagged v$VERSION"
  fi

  if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
    say "tag v$VERSION already exists on origin"
  else
    git push origin "v$VERSION"
    say "pushed tag v$VERSION"
  fi

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    NOTES="docs/release-notes/v$VERSION.md"
    if [ ! -f "$NOTES" ]; then
      say "note: $NOTES does not exist; create the GitHub release by hand"
      return
    fi
    if gh release view "v$VERSION" >/dev/null 2>&1; then
      say "GitHub release v$VERSION already exists"
    else
      gh release create "v$VERSION" --title "v$VERSION" --notes-file "$NOTES"
      say "GitHub release: v$VERSION"
    fi
  else
    say "gh is not logged in; create the GitHub release by hand if you want one"
  fi
}

# 1. A tag must point at the code being published. Publishing a dirty tree is
#    allowed for a quick release, but then the script will not tag it.
if [ "$TAG" -eq 1 ] && [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "--tag needs a clean tree. Commit the release first, then rerun."
fi
if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "the working tree is dirty. Commit first (recommended) or rerun with --allow-dirty."
fi

# A fresh publish must not create an already-used tag. --tag-only is the
# recovery path and handles existing tags idempotently in finish_release().
if [ "$TAG" -eq 1 ] && [ "$TAG_ONLY" -eq 0 ]; then
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    die "tag v$VERSION already exists locally. Bump the version or delete that tag first."
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
    die "tag v$VERSION already exists on origin. Bump the version or delete the remote tag first."
  fi
fi

# Recovery path: npm is already published; only finish the git/GitHub side.
if [ "$TAG_ONLY" -eq 1 ]; then
  PUBLISHED=$(npm view "$PKG@$VERSION" version --cache "$CACHE" 2>/dev/null || true)
  if [ "$PUBLISHED" != "$VERSION" ]; then
    die "npm does not show $PKG@$VERSION (got '${PUBLISHED:-nothing}'). Publish it before using --tag-only."
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: would push $(git rev-parse --abbrev-ref HEAD), tag v$VERSION, and create the GitHub release"
    exit 0
  fi
  finish_release
  exit 0
fi

# 2. Authentication. The token lives in ~/.npmrc; the cache path only avoids a
#    broken cache and does not change who is logged in.
if [ "$DRY_RUN" -eq 0 ]; then
  if ! npm whoami --cache "$CACHE" >/dev/null 2>&1; then
    die "npm rejected the current login (or there is none). Run: npm login
         then rerun this script. If login itself complains about the cache, run:
         npm login --cache $CACHE"
  fi
  say "npm user: $(npm whoami --cache "$CACHE")"
fi

# 3. Do not overwrite a published version; npm would reject it anyway, but the
#    failure is clearer here.
if npm view "$PKG@$VERSION" version --cache "$CACHE" >/dev/null 2>&1; then
  die "$PKG@$VERSION is already published. Bump version in package.json first."
fi

# 4. Tests.
say "running tests…"
node --test test/*.test.mjs

# 5. Secrets and machine-specific strings in the files the tarball ships.
TOKEN_FILE="${DSH_HOME:-$HOME/.dsh}/dsh-mobi-web-token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
  if [ -n "$TOKEN" ] && grep -rIF -- "$TOKEN" lib assets docs README.md LICENSE cordis.patch.yml >/dev/null 2>&1; then
    die "the dsh-mobi-web access token appears in the shipped files; refusing to publish"
  fi
fi
if grep -rIn -- '/Users/\|\.ts\.net\|ngrok' lib assets docs README.md LICENSE cordis.patch.yml >/tmp/dsh-mobi-web-leaks.$$ 2>&1; then
  cat /tmp/dsh-mobi-web-leaks.$$
  rm -f /tmp/dsh-mobi-web-leaks.$$
  die "machine-specific paths or tunnel hostnames appear in the shipped files"
fi
rm -f /tmp/dsh-mobi-web-leaks.$$

# 6. Verify the file whitelist and the files this release depends on.
FILES=$(npm pack --dry-run --json --cache "$CACHE" 2>/dev/null)
printf '%s' "$FILES" | python3 -c '
import json, sys
info = json.load(sys.stdin)[0]
paths = [f["path"] for f in info["files"]]
for bad in ("test/", "HANDOFF.md", "node_modules/", ".tgz", "scripts/"):
    hit = [p for p in paths if p.startswith(bad) or p.endswith(bad)]
    if hit:
        print("unexpected shipped file:", hit[0], file=sys.stderr)
        sys.exit(1)
for required in ("lib/index.js", "lib/page.html", "cordis.patch.yml", "package.json"):
    if required not in paths:
        print("missing required file:", required, file=sys.stderr)
        sys.exit(1)
size_mb = info["size"] / 1024 / 1024
print(f"pack: {len(paths)} files, {size_mb:.1f} MB")
' || die "refusing to publish: the tarball contents are not what this package should ship"

grep -q "createPromptAdmission" lib/index.js || die "lib/index.js is missing the prompt admission code"
grep -q "workspaceRegistry" lib/index.js || die "lib/index.js is missing the workspace resolution"
grep -q "const BUILD = 'v38'" lib/page.html || die "lib/page.html does not carry build v38"

# 7. Publish. npm opens the browser for web-auth/2FA when the account needs it.
say ""
if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run: skipped npm publish"
  exit 0
fi
say "publishing $PKG@$VERSION (a browser window may open for 2FA)…"
npm publish --cache "$CACHE"

# 8. The registry can take a few seconds (sometimes minutes on a first publish)
#    before the version is visible. Poll rather than declaring success blindly.
say "waiting for the registry to show ${VERSION}…"
PUBLISHED=""
for _ in $(seq 1 30); do
  PUBLISHED=$(npm view "$PKG@$VERSION" version --cache "$CACHE" 2>/dev/null || true)
  [ "$PUBLISHED" = "$VERSION" ] && break
  sleep 10
done
if [ "$PUBLISHED" != "$VERSION" ]; then
  say "warning: npm publish returned, but the registry does not show $VERSION yet."
  say "         check later: npm view $PKG@$VERSION version"
  say "         then finish the git side with: scripts/publish.sh --tag-only"
else
  say "published: https://www.npmjs.com/package/$PKG/v/$VERSION"
fi

# 9. Git tag/release is opt-in: it only makes sense on a clean tree.
finish_release

say ""
say "install on this machine:"
say "  dsh plugin --profile desktop add $PKG@$VERSION"
say "  scripts/profile-mode.sh restart   # from Terminal; ends any agent session inside the app"
