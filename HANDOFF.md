# HANDOFF

State as of 2026-11-08: **this machine runs the bundle**, `lib/index.js` + `lib/page.html` served straight from this checkout, **27 tests passing**. The bundle is named **`dsh-mobi-web`** (renamed from `dsh-mobile-gateway` — see "Publishing"). It is still **not published**, and the desktop install is a `link:` to this directory.

The bundle install path is verified twice: on a throwaway clean profile (step 2) and on the real desktop profile (step 3, `scripts/migrate-desktop-to-bundle.sh`). What the flip proved: the row composes as `127.0.0.1:3083`, `GET /__gw/health` 200, `/m/` 401 → 200 after a login with the existing password, `/m/api/sessions` returns real JSON, and both tunnels answer 200.

The page shows its build in the footer (`446ms · v36`). Always read it before debugging a "it's broken on my phone" report — a stale build means a caching problem, not a code problem.

## Where things live

| what | path |
| --- | --- |
| source (this repo) | `~/playground/home-fish/dsh-mobi-web-plugin` (`lib/`, `assets/`) — **this is what the app loads** |
| npm / bundle name | `dsh-mobi-web` (repo dir kept its old name) |
| how the profile gets it | `~/.dsh/profiles/desktop/node_modules/dsh-mobi-web` → symlink to this checkout, listed in `package.json` `dependencies` **and** `dsh.profile.bundles` |
| config override | `~/.dsh/profiles/desktop/cordis.patch.yml` → `- id: dsh-mobi-web` (port 3083 + `blockPaths`) |
| patch guard | `~/.dsh/profiles/desktop/patch-guard/{guard.py,blocks/dsh-mobi-web.yml}` |
| guard LaunchAgent | `~/Library/LaunchAgents/com.dsh.patch-guard.plist` |
| login token | `$DSH_HOME/dsh-mobi-web-token` (mode 0600) |
| gateway listens on | `127.0.0.1:3083` |
| public entrances | `https://dsh.hi5lingo.com/m/` (Cloudflare), `https://yuhuamacbook-pro.tailefe9a0.ts.net/m/` (Tailscale) |
| rollback | `~/.dsh/profiles/desktop/.bundle-migration-20261108-231454/` (old row, guard block, `old-plugin/{gateway34.mjs,mobile.html}`) |

The login token lives in `$DSH_HOME/dsh-mobi-web-token` (0600) — do not paste it into docs or commits. Older copies still exist in `cordis.patch.yml.bak*`, `.before-guard.*` and the migration backup; they predate the move and can be deleted.

**Known wart:** the patch-guard agent is still loaded, now protecting only the 5-line config override. It is the last piece of the old installation; retire it once the app has gone a few restarts without dropping the override.

## Deploy recipe

The ritual is gone — the profile links this directory, and bundle patches are composed by the app.

- **`lib/page.html` only** — nothing to do. Read per request (`cache-control: no-store`).
- **`lib/index.js` (or `cordis.patch.yml` in this repo)** — restart the app (or reload the plugin from the plugin manager). No copy, no bumped filename, no guard snapshot refresh: `dsh plugin add` deleted all of that.
- **`package.json`** — rare; after changing the bundle declaration, re-run `dsh plugin --profile desktop add link:<this repo>` so `dsh.profile.bundles` is reconciled.

Verify after any of those:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/__gw/health        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/m/                 # 401 without cookie
```

If the gateway answers on **3080** instead of 3083, the app dropped the override row: the guard restores it within ~5 min, or restart the app.


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
3. ~~33 historical `gateway*.mjs` copies~~ — **done 2026-11-08**: the whole `plugins/mobile-gateway/` dir (41 files, 6.7 MB) is deleted; the two live files are kept in the migration backup for rollback.
4. **`seenSessions` / `phoneTurns` never shrink.** Prune on `turn/end`.
5. **No session search** on the list, and **no unread marker** — you cannot see which session changed while you were away.
6. **Images in history render as `[图片]`** — fetching the attachment would need a new route.
7. ~~**A `deploy.sh`** would remove the three-step ritual~~ — **obsolete**: there is no ritual left. The profile links this checkout, so a restart is the deploy. `scripts/migrate-desktop-to-bundle.sh` is the one-off that removed the old install.

## Publishing — pick this up in a new session

### Where the packaging stands

The repo follows the same shape as `dsh-whale-widget` (the reference published bundle):

```
package.json       dsh.bundle.patch → cordis.patch.yml; files whitelist; keywords dsh/dsh-plugin; icon; MIT
cordis.patch.yml   the install declaration (an install no longer edits the profile patch)
lib/index.js       the gateway (assets resolved through PACKAGE_ROOT)
lib/page.html      the mobile page
assets/            vendored mermaid (js + gz + br) and the app icon
test/              27 tests, green from the new layout
```

Three real changes came with the move, not just directory shuffling:

- **package-relative assets** — `new URL('./asset/…', import.meta.url)` breaks once the plugin lives in `node_modules`; the page and mermaid now resolve via `PACKAGE_ROOT`.
- **token bootstrap** — with no token configured the plugin mints one into `$DSH_HOME/dsh-mobi-web-token` (0600) and logs *where it is* (the token itself stays out of the log). Without this, a fresh install would be an **open proxy** to the whole harness.
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

**3. ~~The desktop client cannot install via the CLI~~ — half wrong, now measured.** The doc ships two commands: the **npm CLI** rejects `desktop` ("the `desktop` name is reserved for the Electron-owned profile, so the CLI rejects boot and config-dump requests for it. The npm CLI also rejects its plugin-management requests"), while the **Desktop-installed command** may manage the initialized desktop profile. This machine's `~/.local/bin/dsh` *is* the Desktop-installed one (symlink into the app's `runtime/cli/bin/dsh`), and `dsh plugin --profile desktop add link:<repo>` worked: pnpm added the link and `dsh.profile.bundles` gained `dsh-mobi-web`. A no-op probe (`add --help`) first confirmed reconcile would not rewrite the manifest (sha unchanged).

What stays true: **boot and `--dump-config` are still refused for the name `desktop`** — so the composed desktop tree can only be inspected on a renamed copy. That is how the step-3 composition was rehearsed. The README must still document both install paths (npm CLI for web/other profiles, plugin manager or the app's command for desktop).

**4. ~~The security section is buried~~ — done.** The README now opens with "Read this first: what you are exposing": prompts, approvals (shell included), every session, then the Tailscale advice and where the token lives. The "not that package" note sits above it as a two-line blockquote.

**5. ~~The minted token is never logged~~ — fixed.** Three things were wrong at once:

- `resolveToken()` minted silently, so nothing said a token existed or where it went.
- `say()` preferred `ctx.logger`, and **cordis always provides `ctx.logger`** — the `else console.log(...)` branch was dead code in every real boot. Worse, cordis' `LoggerService` only appends to an in-memory ring buffer and registers no stdout exporter, so those lines were invisible everywhere (the desktop app writes nothing to `~/Library/Logs` but crash files).
- The listen callback's wording ("log in with the configured token") named a secret it never showed.

Now: `resolveToken()` returns `{ token, source: 'config'|'env'|'file'|'minted'|'disabled', file, saved }`; `say()` prints every line to stdout *and* mirrors it into `ctx.logger` inside a try/catch (a throwing logger must not kill the host); and the listen callback says `minted … saved to <path> (0600)` + `read it with: cat <path>`, or `token read from <path>` on later boots. **The token itself stays out of the log** — it is one shared secret that grants the whole machine, and it is already in a 0600 file. The single exception is the unwritable-`$DSH_HOME` case (`saved: false`), where the process holds the only copy and echoing it is the only way to keep it usable. Printing the token unconditionally is a one-line change if that trade is ever preferred.

Two tests in `test/token.test.mjs` cover the mint → reuse → configured → disabled matrix, the 0600 mode, and the unwritable-home branch (27 tests total).

Re-verified on the throwaway isolated profile, first boot vs. second boot:

```
[dsh-mobi-web] listening on 127.0.0.1:3183 → 127.0.0.1:3900 (token required)
[dsh-mobi-web] no token was configured, so one was minted and saved to …/dsh-mobi-web-token (mode 0600)
[dsh-mobi-web] read it with: cat …/dsh-mobi-web-token
[dsh-mobi-web] open http://127.0.0.1:3183/m/ on the phone through your tunnel
…
[dsh-mobi-web] listening on 127.0.0.1:3183 → 127.0.0.1:3900 (token required)
[dsh-mobi-web] token read from …/dsh-mobi-web-token
```

Login still worked after the restart (302 → `/m/` 200), so the file — not the process — is the source of truth.

### Still missing for a release

- ~~Screenshots~~ — `docs/screenshot-sessions.png`, rendered from the real page against a fabricated session list (so no real workspace names ship), 390×844 @2x. The fixture script was a throwaway; regenerate by serving `lib/page.html` with a stub `/m/api/sessions`.
- ~~A compatibility line~~ — in the README under "Limits worth knowing"; DSH `0.2.2-rc.1`, with the private-API caveat.
- ~~CI~~ — `.github/workflows/test.yml`, `node --test test/*.test.mjs` on Node 20 and 24, push + PR. **Green on the first run** (42494632153): both jobs success, so the Node 20 floor holds too.
- ~~English summary~~ — the README is English throughout.
- `npm pack --dry-run`: 12 files, 3.0 MB packed / 5.7 MB unpacked (mermaid is 5.4 MB of it). Publishing needs the npm cache to be writable, which the agent sandbox blocks — do it from a normal terminal or with approval.

### Order of work

1. ~~**Rename** to `dsh-mobi-web`~~ — **done** (package, `cordis.patch.yml` id/name, exported name, token filename, both docs). Remaining sub-item: the GitHub repo is still `dsh-mobi-web-plugin`.
2. ~~**Verify the bundle install on a clean profile**~~ — **done for the CLI path** (recipe and evidence under blocker 2). The desktop-plugin-manager half moves with step 3.
3. ~~**Migrate this machine**~~ — **done 2026-11-08** with `scripts/migrate-desktop-to-bundle.sh`. The bundle is in the desktop profile's `dependencies` + `dsh.profile.bundles`, the token lives in `$DSH_HOME/dsh-mobi-web-token` (0600), and the old row is replaced by a 5-line config override.

   Verified after the restart: `/__gw/health` 200, `/m/` 401 → 200 after a login with the **existing** password, `/m/api/sessions` returns real JSON, both tunnels 200, the login page footer carries the new `dsh-mobi-web` name (so the old module is off the wire), and the guard no longer restores the old row (tested by deleting the override from a copy and watching `guard.py` put it back).

   One surprise worth remembering: the app kept serving the *old* module across an earlier `dsh plugin add` — a new bundle only mounts on a restart. The install itself is live-safe; the row is not.
4. ~~**Finish the docs**~~ — **done**: security first, both install paths (npm CLI for web; plugin manager / Desktop command for `desktop`), compatibility line, screenshot. What is left of this step is *review*, not writing.
5. **Publish** — the only step left. Repo is renamed to `dsh-mobi-web`, URLs updated, CI green; what is missing is an npm account with 2FA.

   Publish runbook:

   ```bash
   npm whoami                              # must print the account
   npm view dsh-mobi-web version           # must still be 404
   npm publish                             # 12 files, 3.0 MB
   git tag v0.1.0 && git push origin v0.1.0
   gh release create v0.1.0 --title v0.1.0 --notes-file docs/release-notes/v0.1.0.md
   ```

   Two traps: the agent sandbox cannot write `~/.npm`, so `npm publish` has to run from a normal terminal (or with full-disk approval); and the local `link:` installs prove nothing about the tarball — after publishing, install **from the registry** on a throwaway profile (the step-2 recipe) and re-run the health/login checks. That last check is the real definition of done: the `files` whitelist, not the checkout, decides what ships.

### Definition of done

- ~~A clean profile installs the bundle with one documented action and serves `/m/` with a minted token.~~ — done, twice (clean copy + this machine).
- `npm test` green **on CI** — 27 tests, green on Node 20 and 24 (run 42494632153).
- README opens with what it is, what it exposes, and how to keep it private. — partially: the security warning is still below "Install" (blocker 4).
- ~~The old hand-rolled install and the launchd guard are retired.~~ — the install is gone (dir deleted, rollback copy kept); the **guard is still loaded**, now protecting only the override row.

## Decisions worth not relitigating

- **Sidecar instead of `0.0.0.0`** — dsh refuses non-loopback binds; a tunnel is the only sane transport.
- **Own page instead of the proxied official UI** — 32 KB vs 4.6 MB over a slow relay; the proxy stays as a fallback.
- **Approvals: phone-owned turns cancel rather than delegate** — a desktop nobody is at only moves the deadlock. 15-minute ceiling.
- **Mermaid vendored, not CDN** — works offline and behind the tunnel; the cost is 857 KB, lazy.
- **24 h active window** — the owner's call; do not widen it without asking.
