# HANDOFF

State as of 2026-11-09: **published** as `dsh-mobi-web@0.1.0` on npm, release `v0.1.0`, CI green on Node 20 + 24, 27 tests.

**2026-11-11 (checkout, not published): 0.1.2 fixes the false “发送失败” on queued prompts, the 工作区 back-button race, and phone-created Sessions landing under “Ungrouped”** — see Landmines 4, 5, 12, 13 and 14. The daily profile still runs 0.1.1 until the tarball is installed and the app restarted. The three duplicate prompts from the 15:48 incident were queued and have since run; the session's inbox is empty.

**Two installs, deliberately:**

- **Daily / phone** — the `desktop` profile installs the **registry copy** (`0.1.0`) into `node_modules`. It is a real directory, not a symlink, so moving this checkout cannot break the phone.
- **Development** — `mobi-dev` installs `link:<this checkout>` and listens on **3183**. Start it from a terminal only while testing; it can run next to the daily gateway.

The split exists because of a real incident: `desktop` used to `link:` this checkout, the repo moved from `home-fish/...` to `rainfish-home/...`, the symlink dangled, and the phone entrance silently went down on the next restart. `link:` records an **absolute path**; use it only for `mobi-dev`. `scripts/profile-mode.sh` switches and verifies either mode.

The bundle install path is verified on a throwaway clean profile, on the real desktop profile (`scripts/migrate-desktop-to-bundle.sh`), and again from the registry. What the flip proved: the row composes as `127.0.0.1:3083`, `GET /__gw/health` 200, `/m/` 401 → 200 after a login, `/m/api/sessions` returns real JSON, and both tunnels answer 200.

After the registry switch (2026-11-09, post-restart): `3083` health 200, login 302, `/m/` 200 at 33785 bytes — its sha256 equals the installed `lib/page.html`, so the running gateway is the registry copy — `/m/api/sessions` returns real JSON, Cloudflare and Tailscale both 200. The phone cookie survives: token and cookie-signature domain are unchanged.

**GitHub webhook (separate from the mobile gateway).** On that restart, 3081 was listening but `POST /github` returned **404**: the adapter was not mounted, because both webhook packages were `0.2.1-rc.5` on a `0.2.2-rc.1` runtime. Upgraded both to `0.2.2-rc.1` on 2026-11-09 (backup: `~/.dsh/profiles/desktop/.backup-webhook-20261109-010838/`); the stale `workspacePath` (`home-fish/wukong`) is now `!!js process.env.DSH_GITHUB_REVIEW_WORKSPACE ?? '/Users/yuhua/playground/rainfish-home/wukong'`. **Restart pending**: after it, `POST /github` should answer 401 (invalid signature) instead of 404.

The page shows its build in the footer (`446ms · v36`). Always read it before debugging a "it's broken on my phone" report — a stale build means a caching problem, not a code problem.

## Where things live

| what | path |
| --- | --- |
| source (this repo) | `~/playground/rainfish-home/dsh-mobi-web` (`lib/`, `assets/`) |
| npm / bundle name | `dsh-mobi-web` |
| daily install | `~/.dsh/profiles/desktop` → `dsh-mobi-web@0.1.0` from the registry; `node_modules/dsh-mobi-web` is a **real directory** |
| dev install | `~/.dsh/profiles/mobi-dev` → `link:` to this checkout; gateway **3183**, start with `dsh --profile mobi-dev --port 3184` |
| switch / verify | `scripts/profile-mode.sh status` / `registry` / `local` / `restart` |
| backup before the registry switch | `~/.dsh/profiles/desktop/.backup-before-registry-20261109-005716/` |
| config override | `~/.dsh/profiles/desktop/cordis.patch.yml` → `- id: dsh-mobi-web` (port 3083 + `blockPaths`) |
| patch guard | `~/.dsh/profiles/desktop/patch-guard/{guard.py,blocks/dsh-mobi-web.yml}` |
| guard LaunchAgent | `~/Library/LaunchAgents/com.dsh.patch-guard.plist` |
| login token | `$DSH_HOME/dsh-mobi-web-token` (mode 0600) |
| gateway listens on | `127.0.0.1:3083` (daily), `127.0.0.1:3183` (dev) |
| public entrances | `https://dsh.hi5lingo.com/m/` (Cloudflare), `https://yuhuamacbook-pro.tailefe9a0.ts.net/m/` (Tailscale) |
| rollback | `~/.dsh/profiles/desktop/.bundle-migration-20261108-231454/` (old row, guard block, `old-plugin/{gateway34.mjs,mobile.html}`) |

The login token lives in `$DSH_HOME/dsh-mobi-web-token` (0600) — do not paste it into docs or commits. Older copies still exist in `cordis.patch.yml.bak*`, `.before-guard.*` and the migration backup; they predate the move and can be deleted.

**Known wart:** the patch-guard agent is still loaded, now protecting only the 5-line config override. It is the last piece of the old installation; retire it once the app has gone a few restarts without dropping the override.

Observation log for that decision: the app last rewrote `cordis.patch.yml` on **2026-10-30** (the `.bak.20261030-*` files); the restarts on 2026-11-08 and 2026-11-09 added no new backup and left the override intact. If that holds for another restart or two, `launchctl bootout gui/$(id -u)/com.dsh.patch-guard` + delete the plist is the last line of the definition of done.

## Deploy recipe

**Daily / phone (registry).** The desktop profile runs the published copy; editing this checkout changes nothing until a new version is installed.

- publish `0.1.1` (runbook below), then:
  ```bash
  dsh plugin --profile desktop add dsh-mobi-web@0.1.1
  scripts/profile-mode.sh restart
  ```
- a bundle only mounts at boot, so a restart is required. `scripts/profile-mode.sh status desktop` prints spec / installed copy / health.

**Development (checkout).** Use `mobi-dev`; its `link:` points here and the daily gateway is unaffected.

- start: `dsh --profile mobi-dev --port 3184` → page on `http://127.0.0.1:3183/m/`
- `lib/page.html` — refresh only (read per request, `cache-control: no-store`)
- `lib/index.js` — restart the `mobi-dev` process
- moving this checkout breaks the link; re-run `scripts/profile-mode.sh local mobi-dev`

**An unpublished build on the daily profile (phone test).** Do not hand-copy files into `node_modules`, and do not leave `desktop` on `link:`:

```bash
npm pack                                   # dsh-mobi-web-0.1.1-rc.1.tgz
dsh plugin --profile desktop add ./dsh-mobi-web-0.1.1-rc.1.tgz   # a copy, not a link
scripts/profile-mode.sh restart
# after testing:
scripts/profile-mode.sh registry desktop 0.1.0
```

Verify after any of those:

```bash
scripts/profile-mode.sh status desktop
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/__gw/health        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/m/                 # 401 without cookie
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3183/__gw/health        # 200 only while mobi-dev runs
```

If the gateway answers on **3080** instead of 3083, the app dropped the override row: the guard restores it within ~5 min, or restart the app.


## Landmines

1. **`ctx` inside request handlers.** A bare `ctx.mobile` in a closure crashed the host with `ReferenceError: ctx is not defined` (dsh treats uncaught exceptions as fatal). Always capture first: `const mobile = options.mobile ?? null`.
2. **`[hidden]` loses to class rules.** `.lightbox{display:flex}` outranks the UA `[hidden]{display:none}`, so every hidden element stayed visible — the full-screen overlay covered the whole page and read as a black screen. The page now has a global `[hidden]{display:none !important}`; keep it.
3. **The app rewrites `cordis.patch.yml`.** It once shrank to 661 bytes and dropped hand-written rows. The guard restores registered blocks; it only knows about blocks in `patch-guard/blocks/`, and only if their `# guard-id:` marker is missing.
4. **Approval ownership is per turn, keyed by the phone's rpcId.** `phoneTurns` is set when a `user/message` whose `source.rpcId` matches an admitted phone prompt is committed, and cleared on every `turn/end` (not only while a phone stream is open). A prompt queued behind a running turn must **not** make that running turn phone-owned; conversely, marking it before the message commits was the original "desktop turn never hands back" bug.
5. **A queued prompt is not a transcript event.** `sessionController.prompt()` resolves after the Agent admits the message into its inbox; while a turn is running it waits in `inbox.nextTurn` and only appears as `user/message` when the next turn starts. The gateway used to poll `sessionQuery.readSurface()` for 3.6 s and reject the send when no event appeared — on 2026-11-11 that rejected a correctly queued message twice and put three copies in the real session's queue. Trust the admission result; the page sends a stable `requestId` so retries dedupe (`hasPromptRequest`).
6. **Message payload caps.** `textOf` used to slice at 4 000 chars, silently truncating long answers. It is now 40 k per message plus a 120 k budget across the newest messages (oldest dropped first).
7. **iOS input zoom.** `font:16px/1.4 inherit` is invalid CSS (a shorthand cannot take `inherit`); the computed size fell to 13.3 px and Safari zoomed on focus. Use longhands.
8. **SSE dies on lock screen.** That is fine: the approval stays pending and is re-delivered on reconnect via the session payload. Do not "fix" it by cancelling on disconnect — that was tried and reverted by product decision.
9. **`?t=` links are disabled.** Every bookmarked link now lands on the password form. That is intentional (tokens leak via history/screenshots).
10. **`link:` binds an absolute path.** The desktop profile once linked this checkout; after the repo moved to `rainfish-home/`, the symlink dangled and the bundle silently stopped mounting — no error in the app log, and `/m/` was simply gone. `link:` is for `mobi-dev`; the daily profile uses the registry copy. `scripts/profile-mode.sh status` is the check.
11. **Restart = quit → wait for the process → open.** The gateway port goes `000` when the plugin disposes, a few seconds before the app process exits. `scripts/profile-mode.sh restart` therefore waits on `application ... is running`, then opens the full bundle path and retries if the launch is lost. Opening at port=000 alone re-activates the dying instance and leaves nothing running — that was the first version's bug.
12. **Async reads need a view generation.** `open()`, `refreshOnce()` and the `sendMessage` 700 ms reopen all await a fetch and then paint. Without a `viewSeq` check, a session response that lands after the 工作区 tap repaints the conversation over the list — the back button looks dead. Every navigation bumps `viewSeq`; every response checks it (and the session id) before touching the DOM/SSE. The list is painted immediately on back instead of waiting for its fetch.
13. **A phone create must name the Workspace.** `sessionController.create({cwd})` sets the Session's directory but does not attach it to a Workspace; only `{workspaceId}` does. The old phone `＋` sent cwd only, so the desktop showed every phone-created Session under “Ungrouped” while the phone's list hid it by regrouping loose Sessions by cwd (2026-11-11: this session and the 小猪佩奇 one). `mobile.create()` now resolves `cwd` with `workspaceRegistry.resolveByPath()` and sends `workspaceId`. Existing cwd-only Sessions are repaired by `scripts/attach-sessions.mjs` (run while the app is quit; it backs up `workspace.json`).
14. **A send error must not replace the conversation.** The old page did `main.innerHTML = '<div class="err">…'`, so one failed send erased the whole transcript (the 2026-11-11 screenshot). Errors now append a `.send-error` line under the messages, and the gateway's JSON `{error}` is parsed instead of being shown verbatim.

## Verification

Daily:

```bash
scripts/profile-mode.sh status desktop
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/__gw/health        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/m/                 # 401 without cookie
curl -s -c /tmp/j -o /dev/null -X POST -d "p=$TOKEN" http://127.0.0.1:3083/__gw/login
curl -s -b /tmp/j http://127.0.0.1:3083/m/api/sessions | head -c 200
curl -s -b /tmp/j http://127.0.0.1:3083/__gw/stats | python3 -m json.tool | head -30
```

Development (only while `mobi-dev` is running):

```bash
dsh --profile mobi-dev --port 3184
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3183/__gw/health        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3183/m/                 # 401 without cookie
```

`/__gw/stats` reports `events/taken/delegated/cancelled` and `lastOrigin` — that is how you tell whether an approval went to the phone (`phone`) or was handed back (`desktop`).

UI checks run through headless Chrome on `--remote-debugging-port=9333`; the page needs the login cookie first (`fetch('/__gw/login', …)` then reload).

## Open items

From the last full review, in priority order:

1. **No tests for approvals or SSE.** The two subtlest paths. They live inside `apply()` and are unreachable without cordis — extract an `createApprovalBroker({ … })` and test the origin/timeout matrix.
2. **Host memory**: the brotli cache stores `{compressed, raw}` where `raw` is only used for a length header — up to ~54 MB resident. Store the length instead.
3. ~~33 historical `gateway*.mjs` copies~~ — **done 2026-11-08**: the whole `plugins/mobile-gateway/` dir (41 files, 6.7 MB) is deleted; the two live files are kept in the migration backup for rollback.
4. **`seenSessions` never shrinks.** `phoneTurns` is now pruned on every `turn/end`; `phoneRequests` is capped at 20 ids per session. Prune `seenSessions` on the same edge.
5. **No session search** on the list, and **no unread marker** — you cannot see which session changed while you were away.
6. **Images in history render as `[图片]`** — fetching the attachment would need a new route.
7. ~~**A `deploy.sh`** would remove the three-step ritual~~ — **obsolete, and replaced by a different split**: daily is a registry install + `scripts/profile-mode.sh restart`; development is a restart of `mobi-dev`. `scripts/migrate-desktop-to-bundle.sh` was the one-off that removed the old install.

## Publishing — pick this up in a new session

### Where the packaging stands

The repo follows the same shape as `dsh-whale-widget` (the reference published bundle):

```
package.json       dsh.bundle.patch → cordis.patch.yml; files whitelist; keywords dsh/dsh-plugin; icon; MIT
cordis.patch.yml   the install declaration (an install no longer edits the profile patch)
lib/index.js       the gateway (assets resolved through PACKAGE_ROOT)
lib/page.html      the mobile page
assets/            vendored mermaid (js + gz + br) and the app icon
test/              46 tests, green from the new layout
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

Renamed in `package.json`, `cordis.patch.yml` (`id`/`name`), the exported `name`, the HMAC cookie domain separator, log/error prefixes, and the minted-token filename (`$DSH_HOME/dsh-mobi-web-token`); README and this file updated. The GitHub repo was later renamed to `rainfish-home/dsh-mobi-web`, and the `repository`/`homepage` URLs in `package.json` follow it.

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

- ~~Screenshots~~ — two, `docs/screenshot-{sessions,conversation}.png`, rendered from the real page against fabricated data (390×844 @2x): the list, and a conversation with Markdown + Mermaid + a pending approval card. The fixture script was a throwaway; regenerate by serving `lib/page.html` with stub `/m/api/{sessions,session}` plus `/m/assets/mermaid.js`.
  Rendering the second one exposed a real layout bug: at 390 px a long approval command squeezed 等待批准 into a vertical stack and wrapped 允许一次. `.waiting` now keeps every part on one line (label/chip/buttons `nowrap`, tool chip `flex:none`, reason ellipsised).
- ~~A compatibility line~~ — in the README under "Limits worth knowing"; DSH `0.2.2-rc.1`, with the private-API caveat.
- ~~CI~~ — `.github/workflows/test.yml`, `node --test test/*.test.mjs` on Node 20 and 24, push + PR. **Green on the first run** (42494632153): both jobs success, so the Node 20 floor holds too.
- ~~English summary~~ — the README is English throughout.
- `npm pack --dry-run`: 14 files, ~3.0 MB packed / 5.7 MB unpacked (mermaid is 5.4 MB of it). Publishing needs the npm cache to be writable, which the agent sandbox blocks — do it from a normal terminal or with approval.

### Order of work

1. ~~**Rename** to `dsh-mobi-web`~~ — **done** (package, `cordis.patch.yml` id/name, exported name, token filename, both docs). GitHub repo renamed to `rainfish-home/dsh-mobi-web`; the three URLs in `package.json` follow it.
2. ~~**Verify the bundle install on a clean profile**~~ — **done for the CLI path** (recipe and evidence under blocker 2). The desktop-plugin-manager half moves with step 3.
3. ~~**Migrate this machine**~~ — **done 2026-11-08** with `scripts/migrate-desktop-to-bundle.sh`. The bundle is in the desktop profile's `dependencies` + `dsh.profile.bundles`, the token lives in `$DSH_HOME/dsh-mobi-web-token` (0600), and the old row is replaced by a 5-line config override.

   Verified after the restart: `/__gw/health` 200, `/m/` 401 → 200 after a login with the **existing** password, `/m/api/sessions` returns real JSON, both tunnels 200, the login page footer carries the new `dsh-mobi-web` name (so the old module is off the wire), and the guard no longer restores the old row (tested by deleting the override from a copy and watching `guard.py` put it back).

   One surprise worth remembering: the app kept serving the *old* module across an earlier `dsh plugin add` — a new bundle only mounts on a restart. The install itself is live-safe; the row is not.
4. ~~**Finish the docs**~~ — **done**: security first, both install paths (npm CLI for web; plugin manager / Desktop command for `desktop`), compatibility line, screenshot. What is left of this step is *review*, not writing.
5. ~~**Publish**~~ — **done 2026-11-09**: `dsh-mobi-web@0.1.0`, tag + GitHub release, and the registry build verified by installing it into a throwaway profile.

   What the first publish looked like, because it is not obvious: for a **brand-new package** npm answers `PUT 202 Accepted` and creates a `0.0.0-stage` placeholder ("Temporary package placeholder for staged publishing"); the real version appeared about five minutes later. `npm stage list` stays empty — that is processing, not an approval queue. The publish also goes through the browser web-auth flow when 2FA is on, so it cannot run unattended.

   Publish runbook:

   ```bash
   npm whoami                              # must print the account
   npm view dsh-mobi-web version           # must still be 404
   npm publish                             # 12 files, 3.0 MB
   git tag v0.1.0 && git push origin v0.1.0
   gh release create v0.1.0 --title v0.1.0 --notes-file docs/release-notes/v0.1.0.md
   ```

   `scripts/publish.sh` automates the safe part of this runbook: it requires a clean tree unless `--allow-dirty`, runs the tests, scans the shipped files for the token/machine paths, verifies the tarball whitelist, runs `npm publish`, and waits for the registry. `--tag` also creates/pushes `vX.Y.Z` and the GitHub release; `--dry-run` runs every check and stops before publishing. It needs a valid `npm login` first (the 2026-11-11 token was already 401).

   Before publishing, scan the shipped set — `files` is `lib assets cordis.patch.yml docs README.md LICENSE` plus package.json, and **not** this file:

   ```bash
   TOKEN=$(cat $DSH_HOME/dsh-mobi-web-token)
   grep -rF "$TOKEN" lib assets docs README.md LICENSE cordis.patch.yml   # must be empty
   grep -rn '/Users/\|\.ts\.net\|ngrok' lib assets docs README.md       # must be empty
   ```

   That second grep caught a real one on 2026-11-08: the redirect-loop page had this machine's Tailscale hostname hard-coded. It now fills `location.host` at runtime.

   Two traps: the agent sandbox cannot write `~/.npm`, so `npm publish` has to run from a normal terminal (or with full-disk approval); and the local `link:` installs prove nothing about the tarball — after publishing, install **from the registry** on a throwaway profile (the step-2 recipe) and re-run the health/login checks. That last check is the real definition of done: the `files` whitelist, not the checkout, decides what ships.

### Definition of done

- ~~A clean profile installs the bundle with one documented action and serves `/m/` with a minted token.~~ — done three times: a clean copy, this machine, and **from the registry** after publishing.
- ~~`npm test` green on CI~~ — 27 tests, green on Node 20 and 24 (run 42494632153, and again on every push since).
- ~~README opens with what it is, what it exposes, and how to keep it private.~~ — the exposure section is the first thing after the intro.
- The old hand-rolled install and the launchd guard are retired. — install: gone (dir deleted, rollback copy kept). **Guard: still loaded**, protecting only the 5-line override row. This is the last open item; retire it after a few restarts without the app dropping the override.

## Decisions worth not relitigating

- **Sidecar instead of `0.0.0.0`** — dsh refuses non-loopback binds; a tunnel is the only sane transport.
- **Own page instead of the proxied official UI** — 32 KB vs 4.6 MB over a slow relay; the proxy stays as a fallback.
- **Approvals: phone-owned turns cancel rather than delegate** — a desktop nobody is at only moves the deadlock. 15-minute ceiling.
- **Mermaid vendored, not CDN** — works offline and behind the tunnel; the cost is 857 KB, lazy.
- **24 h active window** — the owner's call; do not widen it without asking.
