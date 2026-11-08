# HANDOFF

State as of the last deploy: **gateway module `gateway34.mjs`**, **page build `v36`**, **25 tests passing**.

The page shows its build in the footer (`446ms · v36`). Always read it before debugging a "it's broken on my phone" report — a stale build means a caching problem, not a code problem.

## Where things live

| what | path |
| --- | --- |
| source (this repo) | `~/playground/home-fish/dsh-mobi-web-plugin` (`lib/`, `assets/`) |
| deployed module + page | `~/.dsh/profiles/desktop/plugins/mobile-gateway/` |
| plugin row | `~/.dsh/profiles/desktop/cordis.patch.yml` → `mobile-gateway-v<NN>` |
| patch guard | `~/.dsh/profiles/desktop/patch-guard/{guard.py,blocks/mobile-gateway.yml}` |
| guard LaunchAgent | `~/Library/LaunchAgents/com.dsh.patch-guard.plist` |
| gateway listens on | `127.0.0.1:3083` |
| public entrances | `https://dsh.hi5lingo.com/m/` (Cloudflare), `https://yuhuamacbook-pro.tailefe9a0.ts.net/m/` (Tailscale) |

The login token lives in the patch row's `token:` field — do not paste it into docs or commits. (With no token configured the plugin mints one into `$DSH_HOME/mobile-gateway-token`.)

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

## Decisions worth not relitigating

- **Sidecar instead of `0.0.0.0`** — dsh refuses non-loopback binds; a tunnel is the only sane transport.
- **Own page instead of the proxied official UI** — 32 KB vs 4.6 MB over a slow relay; the proxy stays as a fallback.
- **Approvals: phone-owned turns cancel rather than delegate** — a desktop nobody is at only moves the deadlock. 15-minute ceiling.
- **Mermaid vendored, not CDN** — works offline and behind the tunnel; the cost is 857 KB, lazy.
- **24 h active window** — the owner's call; do not widen it without asking.
