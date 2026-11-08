# HANDOFF

State as of the last deploy: **gateway module `gateway34.mjs`**, **page build `v36`**, **25 tests passing**. The bundle is named **`dsh-mobi-web`** (renamed from `dsh-mobile-gateway` — see "Publishing").

The repo is now packaged as a DSH bundle (`d24d9f8`), but it is **not published and not yet installed that way** on this machine. Its **CLI install path is verified** on a throwaway clean profile (2026-11-08); the desktop plugin-manager path and the migration of this machine are not — see "Publishing" at the bottom.

The page shows its build in the footer (`446ms · v36`). Always read it before debugging a "it's broken on my phone" report — a stale build means a caching problem, not a code problem.

## Where things live

| what | path |
| --- | --- |
| source (this repo) | `~/playground/home-fish/dsh-mobi-web-plugin` (`lib/`, `assets/`) |
| npm / bundle name | `dsh-mobi-web` (repo dir kept its old name) |
| deployed module + page | `~/.dsh/profiles/desktop/plugins/mobile-gateway/` |
| plugin row | `~/.dsh/profiles/desktop/cordis.patch.yml` → `mobile-gateway-v<NN>` |
| patch guard | `~/.dsh/profiles/desktop/patch-guard/{guard.py,blocks/mobile-gateway.yml}` |
| guard LaunchAgent | `~/Library/LaunchAgents/com.dsh.patch-guard.plist` |
| gateway listens on | `127.0.0.1:3083` |
| public entrances | `https://dsh.hi5lingo.com/m/` (Cloudflare), `https://yuhuamacbook-pro.tailefe9a0.ts.net/m/` (Tailscale) |

The login token lives in the patch row's `token:` field — do not paste it into docs or commits. (With no token configured the plugin mints one into `$DSH_HOME/dsh-mobi-web-token`.)

## The local install is still the hand-rolled one

This repo is packaged as a DSH bundle (`dsh.bundle.patch`), but *this machine* still runs the old setup: a copied `gateway34.mjs` in the profile plus a hand-written patch row, kept alive by the launchd guard.

Migrating is a one-liner — `dsh plugin --profile desktop add link:~/playground/home-fish/dsh-mobi-web-plugin` — and it deletes the whole copy/bump-id/refresh-snapshot ritual, because bundle patches are composed by the app instead of being rewritten by it. It has **not** been done or tested yet: the migration restarts the gateway, so do it when you can watch the app, and keep the guard installed until the bundle install is proven.

## Deploy recipe

Changing **only `mobile.html`** needs no restart: the file is read per request (`cache-control: no-store`).

Changing **`index.mjs`** needs all three steps:

```bash
P=~/.dsh/profiles/desktop
cp index.mjs "$P/plugins/mobile-gateway/gateway<N+1>.mjs"     # new name: the patch reload re-imports
cp mobile.html "$P/plugins/mobile-gateway/mobile.html"
# bump the row id AND the name in cordis.patch.yml, then:
python3 - <<'PY'   # refresh the guard snapshot, or the guard restores the previous version
import pathlib, os
p = pathlib.Path(os.path.expanduser('~/.dsh/profiles/desktop/cordis.patch.yml'))
s = p.read_text(); start = s.index('# ---- mobile gateway (self-hosted)')
pathlib.Path(os.path.expanduser('~/.dsh/profiles/desktop/patch-guard/blocks/mobile-gateway.yml')).write_text(
    '# guard-id: mobile-gateway\n' + s[start:].rstrip('\n') + '\n')
PY
sleep 7 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/__gw/health
```

Editing the *same* module filename only re-applies config — the code stays cached. That has cost hours before.

## Landmines

1. **`ctx` inside request handlers.** A bare `ctx.mobile` in a closure crashed the host with `ReferenceError: ctx is not defined` (dsh treats uncaught exceptions as fatal). Always capture first: `const mobile = options.mobile ?? null`.
2. **`[hidden]` loses to class rules.** `.lightbox{display:flex}` outranks the UA `[hidden]{display:none}`, so every hidden element stayed visible — the full-screen overlay covered the whole page and read as a black screen. The page now has a global `[hidden]{display:none !important}`; keep it.
3. **The app rewrites `cordis.patch.yml`.** It once shrank to 661 bytes and dropped hand-written rows. The guard restores registered blocks; it only knows about blocks in `patch-guard/blocks/`, and only if their `# guard-id:` marker is missing.
4. **Approval ownership is per turn.** `phoneTurns` is set only after a prompt is *verified* to have landed, and cleared on `turn/end`. Marking it earlier meant a later desktop turn could inherit "phone origin" and never hand back.
5. **Message payload caps.** `textOf` used to slice at 4 000 chars, silently truncating long answers. It is now 40 k per message plus a 120 k budget across the newest messages (oldest dropped first).
6. **iOS input zoom.** `font:16px/1.4 inherit` is invalid CSS (a shorthand cannot take `inherit`); the computed size fell to 13.3 px and Safari zoomed on focus. Use longhands.
7. **SSE dies on lock screen.** That is fine: the approval stays pending and is re-delivered on reconnect via the session payload. Do not "fix" it by cancelling on disconnect — that was tried and reverted by product decision.
8. **`?t=` links are disabled.** Every bookmarked link now lands on the password form. That is intentional (tokens leak via history/screenshots).

## Verification

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/__gw/health        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/m/                 # 401 without cookie
curl -s -c /tmp/j -o /dev/null -X POST -d "p=$TOKEN" http://127.0.0.1:3083/__gw/login
curl -s -b /tmp/j http://127.0.0.1:3083/m/api/sessions | head -c 200
curl -s -b /tmp/j http://127.0.0.1:3083/__gw/stats | python3 -m json.tool | head -30
```

`/__gw/stats` reports `events/taken/delegated/cancelled` and `lastOrigin` — that is how you tell whether an approval went to the phone (`phone`) or was handed back (`desktop`).

UI checks run through headless Chrome on `--remote-debugging-port=9333`; the page needs the login cookie first (`fetch('/__gw/login', …)` then reload).

## Open items

From the last full review, in priority order:

1. **No tests for approvals or SSE.** The two subtlest paths. They live inside `apply()` and are unreachable without cordis — extract an `createApprovalBroker({ … })` and test the origin/timeout matrix.
2. **Host memory**: the brotli cache stores `{compressed, raw}` where `raw` is only used for a length header — up to ~54 MB resident. Store the length instead.
3. **33 historical `gateway*.mjs` copies** in the profile plugin dir (1.4 MB). Only the referenced one is live.
4. **`seenSessions` / `phoneTurns` never shrink.** Prune on `turn/end`.
5. **No session search** on the list, and **no unread marker** — you cannot see which session changed while you were away.
6. **Images in history render as `[图片]`** — fetching the attachment would need a new route.
7. **A `deploy.sh`** would remove the three-step ritual above, including the easy-to-forget guard refresh.

## Publishing — pick this up in a new session

### Where the packaging stands

The repo follows the same shape as `dsh-whale-widget` (the reference published bundle):

```
package.json       dsh.bundle.patch → cordis.patch.yml; files whitelist; keywords dsh/dsh-plugin; icon; MIT
cordis.patch.yml   the install declaration (an install no longer edits the profile patch)
lib/index.js       the gateway (assets resolved through PACKAGE_ROOT)
lib/page.html      the mobile page
assets/            vendored mermaid (js + gz + br) and the app icon
test/              25 tests, green from the new layout
```

Three real changes came with the move, not just directory shuffling:

- **package-relative assets** — `new URL('./asset/…', import.meta.url)` breaks once the plugin lives in `node_modules`; the page and mermaid now resolve via `PACKAGE_ROOT`.
- **token bootstrap** — with no token configured the plugin mints one into `$DSH_HOME/dsh-mobi-web-token` (0600) and logs it. Without this, a fresh install would be an **open proxy** to the whole harness.
- **default export** — `export default { name, inject, apply }` alongside the named exports, matching cordis conventions.

### Blockers before publishing

**1. ~~The npm name is taken~~ — done: renamed to `dsh-mobi-web`.** `dsh-mobile-gateway` belongs to someone else, in the same niche:

```
dsh-mobile-gateway  0.2.1  bitxeno/dsh-mobile-gateway
"手机访问网关：局域网扫码 + 公网隧道，把电脑上的 DSH 实时同步到手机（含设置页）"
```

Availability checked at the time (re-check before publishing — npm names are global):

| candidate | npm |
| --- | --- |
| `dsh-mobi-web` | free — **chosen** |
| `dsh-phone-web` | free |
| `dsh-mobile-client` | free |
| `dsh-mobile-web` | taken (0.1.7) |

Renamed in `package.json`, `cordis.patch.yml` (`id`/`name`), the exported `name`, the HMAC cookie domain separator, log/error prefixes, and the minted-token filename (`$DSH_HOME/dsh-mobi-web-token`); README and this file updated. The GitHub repo is still `dsh-mobi-web-plugin`, so the `repository`/`homepage` URLs in `package.json` are unchanged on purpose — rename the repo (or update the URLs) before publishing.

The README now opens with the differentiation: the other package is "scan a QR code + a settings page + live sync"; this one is a **32 KB phone-first page**, **approvals that stay on the phone when the phone started the turn**, and Mermaid rendering. Without that sentence it reads like a duplicate.

**2. ~~The bundle install path has never been exercised~~ — CLI path verified on a clean profile.** Reproduced on a copy of the shipped `web` template, booted from an isolated `$DSH_HOME` so the live app was never touched:

```
cp -a ~/.dsh/profiles/web ~/.dsh/profiles/bundlecheck
dsh plugin --profile bundlecheck add link:<repo>
  → dependencies: + dsh-mobi-web 0.1.0 <- <repo>
  → dsh.profile.bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-mobi-web]
dsh --profile bundlecheck --dump-config
  → row `dsh-mobi-web`, config listenHost 127.0.0.1 / listenPort 3083 (from the bundle)
```

`dsh plugin add` is not a bare pnpm forwarder: after pnpm exits it reconciles `dsh.profile.bundles` against the installed state and appends any dependency whose manifest declares `dsh.bundle.patch` (`@deepseek-ai/dsh/lib/plugin-9h8shc4d.js`, `reconcilePlugins`). That is why the one-liner is enough — **provided `package.json` keeps `dsh.bundle.patch`.** Booting that profile (port overridden to 3183 for the test; the app command line is `dsh --profile <name> --port <n>` — appending `web` is rejected, since the profile name *is* the app) gave:

| check | result |
| --- | --- |
| `GET /__gw/health` | 200 |
| `GET /m/` without cookie | 401 |
| `$DSH_HOME/dsh-mobi-web-token` | minted, 33 bytes, mode 0600 |
| `POST /__gw/login` → `GET /m/` | 302 → 200 |
| `GET /m/api/sessions` | real workspace/session JSON |
| `GET /__gw/stats` | counters + approval diagnostics |

Not yet observed: the **desktop plugin manager** path (that is step 3, and it mutates this machine). Also unverified: an install from the *registry* rather than `link:` — pnpm resolves `link:` locally, so tarball/first-publish behaviour is still inferred.

**3. The desktop client cannot install via the CLI.** Install with `dsh plugin --profile web add <pkg>` works for the web profile, but `--profile desktop` is rejected (it errored out when tried). Desktop users have to install through the app's own plugin manager. The README must document both paths separately.

**4. The security section is buried.** Holding the token means: send prompts, approve tool calls (shell included), read every session on the machine. That belongs at the top of the README, with "put it behind Tailscale, not a public tunnel" next to it.

**5. The minted token is never logged.** The README says the token is "printed in the startup log"; it is not. `resolveToken()` mints silently and `apply()` only reports `listening on … (token required)` plus `log in with the configured token` (lib/index.js `resolveToken`, and the `say('info', …)` pair at the listen callback). Worse, `say()` prefers `ctx.logger`, so in a CLI boot *no* `[dsh-mobi-web]` line reaches stdout at all — the test instance printed only `dsh web: …`. A fresh installer therefore has to know to `cat $DSH_HOME/dsh-mobi-web-token` from the README. Pick one: log the path (safe) or the token itself (convenient, but a secret in a log file), and make `say()` fall back to stdout when the logger is silent. Either way the README sentence needs to match reality.

### Still missing for a release

- Screenshots (the ones in the design notes work).
- A compatibility line: verified on DSH `0.2.2-rc.1` (installation reports `dsh 0.2.2-rc.1`; the packaging was written against `0.2.1-rc.5`); `ctx.get('sessionQuery')` and friends are private API and can drift.
- CI running `npm test` on push.
- An English summary if the audience is not only Chinese-speaking.

### Order of work

1. ~~**Rename** to `dsh-mobi-web`~~ — **done** (package, `cordis.patch.yml` id/name, exported name, token filename, both docs). Remaining sub-item: the GitHub repo is still `dsh-mobi-web-plugin`.
2. ~~**Verify the bundle install on a clean profile**~~ — **done for the CLI path** (recipe and evidence under blocker 2). The desktop-plugin-manager half moves with step 3.
3. **Migrate this machine** to the bundle install — `dsh plugin add link:…` **or** the in-app manager. This restarts the gateway, so do it while watching the app; keep the guard until the bundle install is proven. After that the whole copy/bump-id/refresh-snapshot ritual disappears.
4. **Finish the docs**: screenshots, security section first, compatibility, both install paths.
5. **Publish**: `0.1.0` → `npm publish` → GitHub release → CI.

### Definition of done

- A clean profile installs the bundle with one documented action and serves `/m/` with a minted token.
- `npm test` green on CI.
- README opens with what it is, what it exposes, and how to keep it private.
- The old hand-rolled install and the launchd guard are retired.

## Decisions worth not relitigating

- **Sidecar instead of `0.0.0.0`** — dsh refuses non-loopback binds; a tunnel is the only sane transport.
- **Own page instead of the proxied official UI** — 32 KB vs 4.6 MB over a slow relay; the proxy stays as a fallback.
- **Approvals: phone-owned turns cancel rather than delegate** — a desktop nobody is at only moves the deadlock. 15-minute ceiling.
- **Mermaid vendored, not CDN** — works offline and behind the tunnel; the cost is 857 KB, lazy.
- **24 h active window** — the owner's call; do not widen it without asking.
