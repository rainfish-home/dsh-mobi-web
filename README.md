# dsh-mobi-web-plugin

A phone-first web client for **DeepSeek Harness**, served by a sidecar gateway that runs *inside* the harness process.

```
phone browser  ──HTTPS──▶  Cloudflare tunnel / Tailscale  ──▶  127.0.0.1:3083 (this plugin)  ──▶  harness host services
```

## Why this exists

The official web UI ships ~4.6 MB of JavaScript. Over a relayed mobile link (0.4 MB/s in practice) that is ten-plus seconds of white screen, and the layout assumes a trackpad. This gateway serves a **~32 KB** page instead and talks to the same host services in-process, so it can do things a proxied UI cannot — like holding an approval the desktop never sees.

## What you get

**Browse**
- Sessions grouped by workspace, newest activity first (same `SessionSummary.updatedAt` the desktop orders by)
- Split into *active* (running, or touched within 24 h) and *older* (collapsed, remembered per workspace)
- Archived sessions are filtered out; workspace collapse state persists

**Read**
- Markdown: headings, lists, tables, blockquotes, links, inline code, fenced code
- Mermaid fenced blocks render as SVG; tap one to open it full-screen (pan + pinch), tap again to close
- Long messages fold to ~460 px with "展开全文"
- Live token streaming: the reply grows word by word

**Do**
- Send multi-line text (Enter inserts a newline; the send button is the only way to send)
- Send images (up to 4, inline base64, 4 MB each)
- Stop a running turn
- Create a session in any workspace (`＋` on the workspace header)
- Jump back to the newest message

**Approve**
- Approval requests arrive as cards over SSE
- **Origin affinity**: if the *phone* started the turn, the approval stays on the phone. It waits up to 15 minutes, then **cancels** — it never falls back to a desktop nobody is sitting at. Desktop-origin turns keep the old behaviour (20 s grace, then hand back).

**Stay up**
- SSE with exponential-backoff reconnect (2 s → 30 s) and a 6 s poll as fallback
- A launchd guard restores the plugin's `cordis.patch.yml` row if the app rewrites that file

## Install

1. Copy this directory to `~/.dsh/profiles/desktop/plugins/mobile-gateway/`.
2. Add the plugin row to `~/.dsh/profiles/desktop/cordis.patch.yml` (see `cordis.snippet.yml`).
3. Install the patch guard: `patch-guard/guard.py` + `~/Library/LaunchAgents/com.dsh.patch-guard.plist` (watch `cordis.patch.yml`, restore any block from `patch-guard/blocks/` whose marker is missing).
4. Expose it: `tailscale serve --bg 3083`, or a Cloudflare tunnel ingress pointing at `127.0.0.1:3083`.
5. Open `/m/` and log in with the configured token.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `listenHost` | `127.0.0.1` | never bind wider; a tunnel does the rest |
| `listenPort` | `3083` | |
| `token` | — | password for the cookie gate; empty disables the gate |
| `allowTokenUrl` | `false` | accept `?t=…` links (leaks via history, off by default) |
| `blockPaths` | `[]` | path prefixes answered `204` to keep the page light |
| `approvalPriority` | `'phone-first'` | `'desktop'` disables interception entirely |
| `pwa` | `true` | inject manifest + icon into the proxied UI |
| `brotli` | `true` | recompress JS for the proxied UI |

## Routes

| route | what |
| --- | --- |
| `GET /m/` | the mobile page (cookie-gated) |
| `GET /m/api/sessions` | workspace-grouped list (10 s cache) |
| `GET /m/api/session?id=` | messages (newest 40 / 120 k chars) + pending approvals |
| `GET /m/api/events?session=` | SSE: `state`, `message`, `astart`, `adelta`, `aend`, `tool`, `approval`, `approval-done` |
| `POST /m/api/prompt` | `{id, text, images[]}` — verifies the message actually landed |
| `POST /m/api/cancel` | interrupt the running turn |
| `POST /m/api/create` | `{cwd}` → new session |
| `POST /m/api/approve` | `{id, decision}` |
| `GET /__gw/health` | unauthenticated liveness |
| `GET /__gw/stats` | counters + approval diagnostics (cookie-gated) |

## Design notes

- **No `0.0.0.0`.** `dsh` refuses to start on a non-loopback host, so a sidecar proxy is the only option; the tunnel terminates TLS outside.
- **Cookie minting happens server-side.** Letting the launch-token flow redirect through `303` dropped the `SameSite=Strict` cookie on iOS, producing `ERR_TOO_MANY_REDIRECTS`.
- **Every request handler is wrapped in try/catch.** dsh treats an uncaught exception as fatal; a sidecar must never crash the host.
- **Hot reload needs new filenames.** The plugin patch reloads by re-importing, so each deploy uses `gatewayNN.mjs` and a bumped row id. Editing the *same* file only re-applies config, not code.

## Limits worth knowing

- Single user, single host. No account model beyond one shared token.
- No push notifications: if the phone is asleep, an approval waits for you (up to 15 min) rather than pinging you.
- Images inside *historical* messages render as `[图片]` — only the fact they existed is kept.
- Mermaid is vendored (857 KB brotli), lazy-loaded on the first diagram.
- Sessions cannot be moved between workspaces — DSH derives membership from the session's `cwd` at creation.

## Tests

```bash
node --test test/*.test.mjs    # 25 tests, no network, fake host services
```
