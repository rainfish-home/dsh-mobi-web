// dsh-mobi-web — a sidecar HTTP/WS reverse proxy for the DeepSeek Harness
// web server. It never rebinds the harness listener: it reads the live port from
// `ctx.webServer` on every request and forwards to 127.0.0.1, rewriting Host and
// Origin so the harness browser-trust fence and its launch-token session both
// accept the request no matter which hostname (Tailscale, Cloudflare, LAN) the
// phone used.
//
// Zero dependencies: node:http, node:net, node:fs, node:crypto only.

import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Bundle layout: lib/index.js -> package root. Assets stay package-relative so
// the plugin works the same from node_modules, a local link, or a checkout.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

export const name = 'dsh-mobi-web'
export const inject = ['webServer']

const DEFAULTS = {
  listenHost: '127.0.0.1',
  listenPort: 3080,
  upstreamHost: '127.0.0.1',
  upstreamPort: 0,
  token: '',
  tokenEnv: 'DSH_GATEWAY_TOKEN',
  allowInsecure: false,
  pwa: true,
  blockPaths: [],
  brotli: true,
  approvalPriority: 'phone-first',
  allowTokenUrl: false,
  dropClientPlugins: [],
}

const COOKIE = 'dshgw'
const MAX_FORM_BYTES = 4096
const MAX_HTML_BYTES = 4 * 1024 * 1024
const FAIL_WINDOW_MS = 60_000
const FAIL_LIMIT = 10

const isLoopback = (host) =>
  host === 'localhost' || host === '::1' || host === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)

const cookieValue = (req) => {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

const safeEqual = (a, b) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

const sign = (token) =>
  crypto.createHmac('sha256', token).update('dsh-mobi-web/v1').digest('base64url')

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * Build one gateway. Exported so tests can drive it without a cordis context.
 * `getUpstream()` is called per request: the desktop app binds port 0, so the
 * real port is discovered, never cached.
 */
export function createGateway(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const getUpstream = options.getUpstream ?? (() => ({
    host: opts.upstreamHost,
    port: opts.upstreamPort,
  }))
  const getLaunchPath = options.getLaunchPath ?? (() => null)
  const ensureSession = options.ensureSession ?? (async () => null)
  const invalidateSession = options.invalidateSession ?? (() => {})
  const log = options.log ?? (() => {})
  const token = String(opts.token ?? '')

  // The mobile session adapter is handed in by apply() as `options.mobile`.
  // Capture it here: the request handler below is NOT lexically inside apply(),
  // so a bare `ctx.mobile` reference is a ReferenceError. That throw escapes the
  // http server callback, becomes an uncaught exception, and dsh treats those as
  // fatal — which is how the whole host was dying on every proxied request.
  const mobile = options.mobile ?? opts.mobile ?? null
  // Same lexical trap as `mobile`: the request handler is not inside apply().
  const openStream = options.openStream ?? opts.openStream ?? null

  if (!isLoopback(String(opts.listenHost)) && token === '' && !opts.allowInsecure) {
    throw new Error(
      `dsh-mobi-web: refusing to listen on ${opts.listenHost} without a token — ` +
      'set config.token (or DSH_GATEWAY_TOKEN), or set allowInsecure: true on a trusted network',
    )
  }

  const failures = new Map()
  const upgraded = new Set()
  const redirects = new Map()
  const brotliCache = new Map()
  const recent = []
  const counters = { requests: 0, slow: 0, errors: 0 }
  const record = (row) => {
    recent.push(row)
    if (recent.length > 60) recent.shift()
    if (row.ms > 3000) counters.slow += 1
    if (row.status >= 500) counters.errors += 1
  }

  // Loop breaker: if a phone keeps bouncing on the launch-token redirect (the
  // classic mobile cookie-drop failure), stop redirecting and say so instead of
  // letting the browser die on ERR_TOO_MANY_REDIRECTS.
  const trackRedirect = (req, target) => {
    const key = clientKey(req)
    const now = Date.now()
    const row = redirects.get(key)
    if (!row || row.resetAt <= now) {
      redirects.set(key, { count: 1, resetAt: now + 30_000 })
      return target
    }
    row.count += 1
    return row.count > 8 ? null : target
  }

  const gate = (req, res, url) => {
    if (token === '') return 'pass'

    // A launch token in the URL leaks through history, screenshots and shared
    // links, so it is off by default: the password form is the only door.
    const presented = opts.allowTokenUrl === true ? url.searchParams.get('t') : null
    if (presented !== null) {
      if (safeEqual(presented, token)) {
        setCookie(req, res, sign(token))
        redirect(res, stripToken(url))
        return 'handled'
      }
      bump(failures, clientKey(req))
      challenge(res, 401, '密码不正确')
      return 'handled'
    }

    const cookie = cookieValue(req)
    if (cookie !== undefined && safeEqual(cookie, sign(token))) return 'pass'

    if (url.pathname === '/__gw/login' && req.method === 'POST') {
      readBody(req, MAX_FORM_BYTES).then((body) => {
        const given = new URLSearchParams(body).get('p') ?? ''
        const key = clientKey(req)
        if (overLimit(failures, key)) return tooMany(res)
        if (given !== '' && safeEqual(given, token)) {
          failures.delete(key)
          setCookie(req, res, sign(token))
          redirect(res, '/')
        } else {
          bump(failures, key)
          challenge(res, 401, '密码不正确')
        }
      }).catch(() => challenge(res, 400, '请求格式不对'))
      return 'handled'
    }

    // Ordinary unauthenticated requests are not failures: counting them turned
    // ten page reloads into a one-minute lockout.
    challenge(res, 401, '需要访问密码')
    return 'handled'
  }

  // A throw that escapes an http server callback is an uncaught exception, and
  // dsh treats every uncaught exception as fatal: the host exits 1 and the
  // desktop app reports a crash. A sidecar proxy must never be able to do that,
  // so the request body lives in its own function and always runs behind a guard.
  const handleRequest = (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://gw.invalid')
    } catch {
      res.writeHead(400).end('bad request')
      return
    }

    if (url.pathname === '/__gw/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }

    // Mobile-first trimming: the remote browser only needs the app itself, not
    // multi-megabyte decoration bundles. Prefix match, answered 204 so the SPA's
    // loader fails quietly instead of retrying a 404.
    if (opts.blockPaths.some((prefix) => url.pathname.startsWith(prefix))) {
      res.writeHead(204, { 'cache-control': 'max-age=600' }).end()
      return
    }
    if (url.pathname === '/__gw/manifest.webmanifest') return manifest(res)
    if (url.pathname === '/__gw/icon.png') return icon(res)

    if (gate(req, res, url) !== 'pass') return

    if (url.pathname === '/__gw/stats') return statsPage(res, recent, counters, opts.approvalStats)
    if (url.pathname === '/m/assets/mermaid.js') return mermaidAsset(req, res)
    if (url.pathname === '/m' || url.pathname === '/m/') return mobilePage(res)
    // Only the /m/api/* routes need the adapter. An unconditional `if (!mobile)`
    // here would short-circuit ordinary proxying whenever no adapter is mounted.
      if (url.pathname === '/m/api/events') {
        const sessionId = url.searchParams.get('session') ?? ''
        return openStream
          ? openStream(req, res, sessionId)
          : res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('live stream unavailable')
      }
    if (url.pathname.startsWith('/m/api/')) {
      if (!mobile) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('mobile api unavailable')
        return
      }
      if (url.pathname === '/m/api/sessions') {
        return mobileJson(res, () => mobile.list())
      }
      if (url.pathname === '/m/api/session') {
        const id = url.searchParams.get('id') ?? ''
        return mobileJson(res, () => mobile.read(id))
      }
      if (url.pathname === '/m/api/cancel' && req.method === 'POST') {
        return mobileJson(res, async () => {
          const body = await readBody(req, 16 * 1024)
          const payload = JSON.parse(body)
          return mobile.cancel(payload?.id)
        })
      }
      if (url.pathname === '/m/api/approve' && req.method === 'POST') {
        return mobileJson(res, async () => {
          const body = await readBody(req, 16 * 1024)
          const payload = JSON.parse(body)
          return mobile.resolve(payload?.id, payload?.decision)
        })
      }
      if (url.pathname === '/m/api/prompt' && req.method === 'POST') {
        return mobileJson(res, async () => {
          const body = await readBody(req, 12 * 1024 * 1024)
          const payload = JSON.parse(body)
          return mobile.prompt(payload?.id, payload?.text, payload?.images, payload?.requestId)
        })
      }
      if (url.pathname === '/m/api/create' && req.method === 'POST') {
        return mobileJson(res, async () => {
          const body = await readBody(req, 16 * 1024)
          const payload = body === '' ? {} : JSON.parse(body)
          return mobile.create(payload?.cwd)
        })
      }
    }

    const startedAt = Date.now()
    const finish = () => record({
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname + (url.search ? '?…' : ''),
      status: res.statusCode,
      ms: Date.now() - startedAt,
      bytes: Number(res.getHeader('content-length') ?? 0),
      dest: req.headers['sec-fetch-dest'] ?? '',
    })
    res.on('finish', finish)
    res.on('close', () => { if (!res.writableFinished) finish() })

    proxyHttp(req, res, url, {
      getUpstream, getLaunchPath, log, pwa: opts.pwa, brotli: opts.brotli, brCache: brotliCache,
      dropClientPlugins: opts.dropClientPlugins,
      ensureSession, invalidateSession, trackRedirect, mobile,
    }).catch((error) => {
      log('request failed', error.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('dsh-mobi-web: internal error\n')
      }
    })
  }

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res)
    } catch (error) {
      log('request handler threw:', error?.stack ?? String(error))
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('dsh-mobi-web: internal error\n')
        } else {
          res.destroy()
        }
      } catch {}
    }
  })

  const handleUpgrade = (req, socket, head) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    if (token !== '' && !safeEqual(cookieValue(req) ?? '', sign(token))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    const up = getUpstream()
    const upstream = net.connect(up.port, up.host, () => {
      const headers = { ...req.headers, host: `${up.host}:${up.port}` }
      if (headers.origin) headers.origin = `http://${up.host}:${up.port}`
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    socket.on('close', () => upstream.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head)
    } catch (error) {
      log('upgrade handler threw:', error?.stack ?? String(error))
      try { socket.destroy() } catch {}
    }
  })

  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.listenPort, opts.listenHost, () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })

  const close = () => new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections?.()
    // Upgraded sockets are detached from the HTTP server's own tracking, so
    // close() alone would wait on them forever.
    for (const socket of upgraded) socket.destroy()
    upgraded.clear()
  })

  return { server, listen, close, port: () => server.address()?.port, tokenEnabled: token !== '' }
}

/* ── proxy ─────────────────────────────────────────────────────────────── */

async function proxyHttp(req, res, url, ctx, attempt = 0) {
  const up = ctx.getUpstream()
  const port = up.port
  if (!Number.isInteger(port) || port <= 0) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      .end('dsh-mobi-web: upstream web server is not listening yet')
    return
  }

  const headers = { ...req.headers, host: `${up.host}:${port}` }
  if (headers.origin) headers.origin = `http://${up.host}:${port}`
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? (req.socket.encrypted ? 'https' : 'http')
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''

  // The harness mints its browser-session cookie on `/?token=<launchToken>`.
  // Mobile browsers routinely drop that cookie across a 302→303 chain, which
  // shows up as ERR_TOO_MANY_REDIRECTS. So the gateway does the exchange itself
  // and replays the cookie on every upstream request the browser did not
  // authenticate: the phone never has to keep a third-party-style cookie.
  if (attempt > 0 || !headers.cookie) {
    const minted = await ctx.ensureSession(port)
    if (minted) headers.cookie = minted
  }

  const upstream = http.request({
    host: up.host,
    port,
    method: req.method,
    path: req.url,
    headers,
    agent: false,
    timeout: 30_000,
  })

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout after 30s')))

  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy()
    ctx.log('upstream error', error.message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`dsh-mobi-web: upstream unreachable (${error.code ?? error.message})`)
  })

  upstream.on('response', (upRes) => {
    if (upRes.statusCode === 401 && attempt === 0 && (req.method === 'GET' || req.method === 'HEAD')) {
      upRes.resume()
      upRes.destroy()
      ctx.invalidateSession(port)
      ctx.ensureSession(port).then((cookie) => {
        if (cookie) return proxyHttp(req, res, url, ctx, 1)
        const launch = isDocument(req) ? ctx.getLaunchPath() : null
        if (launch) {
          const target = ctx.trackRedirect(req, launch)
          if (target) return redirect(res, target)
          return redirectLoopPage(res)
        }
        res.writeHead(upRes.statusCode ?? 401, { 'content-type': 'text/plain; charset=utf-8' })
          .end('dsh-mobi-web: the harness rejected the session and no launch token is available\n')
      }).catch((error) => {
        ctx.log('session exchange failed', error.message)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('dsh-mobi-web: session exchange failed\n')
      })
      return
    }

    const type = String(upRes.headers['content-type'] ?? '')
    const encoding = String(upRes.headers['content-encoding'] ?? '').toLowerCase()
    const decodable = encoding === '' || encoding === 'gzip' || encoding === 'deflate' || encoding === 'br'
    const wantInject = ctx.pwa && type.includes('text/html') && decodable

    // The client bundle is ~9 MB of JS that the app already gzips to ~4.2 MB.
    // Brotli gets that to ~2.5 MB, which matters a lot on a slow uplink. Cached
    // per URL so the cost is paid once.
    const brWanted = ctx.brotli &&
      (type.includes('javascript') || type.includes('text/css')) &&
      String(req.headers['accept-encoding'] ?? '').includes('br') &&
      (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br' || encoding === '')
    if (brWanted) {
      const key = req.url
      const cached = ctx.brCache.get(key)
      if (cached) {
        res.writeHead(upRes.statusCode ?? 200, brHeaders(upRes.headers, cached.raw.length, cached.compressed.length))
        res.end(cached.compressed)
        upRes.resume()
        return
      }
      const chunks = []
      let size = 0
      upRes.on('data', (chunk) => { size += chunk.length; if (size <= 24 * 1024 * 1024) chunks.push(chunk) })
      upRes.on('end', () => {
        try {
          const raw = decode(Buffer.concat(chunks), encoding)
          const compressed = zlib.brotliCompressSync(raw, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
          })
          if (ctx.brCache.size > 6) ctx.brCache.clear()
          ctx.brCache.set(key, { compressed, raw })
          res.writeHead(upRes.statusCode ?? 200, brHeaders(upRes.headers, raw.length, compressed.length))
          res.end(compressed)
        } catch {
          res.writeHead(upRes.statusCode ?? 200, upRes.headers)
          res.end()
        }
      })
      return
    }

    if (!wantInject) {
      res.writeHead(upRes.statusCode ?? 502, forwardHeaders(upRes.headers, headers['x-forwarded-proto'] === 'https'))
      upRes.pipe(res)
      return
    }

    const chunks = []
    let size = 0
    upRes.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_HTML_BYTES) return
      chunks.push(chunk)
    })
    upRes.on('end', () => {
      let raw = Buffer.concat(chunks)
      try {
        raw = decode(raw, encoding)
      } catch {
        res.writeHead(upRes.statusCode ?? 200, forwardHeaders(upRes.headers, false))
        res.end(raw)
        return
      }
      const trimmed = trimBoot(raw.toString('utf8'), ctx.dropClientPlugins)
      const body = Buffer.from(injectPwa(trimmed), 'utf8')
      const out = forwardHeaders(upRes.headers, headers['x-forwarded-proto'] === 'https')
      out['content-length'] = String(body.length)
      delete out['transfer-encoding']
      delete out['content-encoding']
      delete out.etag
      res.writeHead(upRes.statusCode ?? 200, out)
      res.end(body)
    })
  })

  req.pipe(upstream)
}

/** Copy upstream headers, relaxing the harness's SameSite=Strict session cookie. */
function forwardHeaders(source, https) {
  const out = { ...source }
  const cookie = out['set-cookie']
  if (cookie !== undefined) {
    const list = Array.isArray(cookie) ? cookie : [cookie]
    out['set-cookie'] = list.map((one) => {
      let value = String(one).replace(/;\s*SameSite=Strict/i, '; SameSite=Lax')
      if (https && !/;\s*Secure/i.test(value)) value += '; Secure'
      return value
    })
  }
  return out
}


const isDocument = (req) =>
  req.headers['sec-fetch-dest'] === 'document' ||
  String(req.headers.accept ?? '').includes('text/html')

const PWA_HEAD = [
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="DSH">',
  '<link rel="apple-touch-icon" href="/__gw/icon.png">',
  '<link rel="manifest" href="/__gw/manifest.webmanifest">',
].join('')

function decode(buffer, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(buffer)
  if (encoding === 'deflate') return zlib.inflateSync(buffer)
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer)
  return buffer
}

function injectPwa(html) {
  if (html.includes('/__gw/manifest.webmanifest')) return html
  const at = html.search(/<\/head\s*>/i)
  if (at < 0) return html
  return html.slice(0, at) + PWA_HEAD + html.slice(at)
}

/* ── small http helpers ────────────────────────────────────────────────── */

const clientKey = (req) => {
  // Behind Cloudflare / tailscaled every socket is loopback, so the socket
  // address would put every visitor in one rate-limit bucket.
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function bump(map, key) {
  const now = Date.now()
  const row = map.get(key)
  if (!row || row.resetAt <= now) return map.set(key, { count: 1, resetAt: now + FAIL_WINDOW_MS })
  row.count += 1
}

const overLimit = (map, key) => {
  const row = map.get(key)
  return row !== undefined && row.resetAt > Date.now() && row.count >= FAIL_LIMIT
}

const stripToken = (url) => ({ pathname: url.pathname, search: '' })

function setCookie(req, res, value) {
  const https = String(req.headers['x-forwarded-proto'] ?? '') === 'https'
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 24 * 3600}`]
  if (https) attrs.push('Secure')
  res.setHeader('set-cookie', attrs.join('; '))
}

function redirect(res, target) {
  const location = typeof target === 'string' ? target : (target.pathname + target.search)
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end()
}

/**
 * Drop client plugins the phone does not need from the boot manifest. The
 * client builds its combined `/plugins/??...` request from this roster, so a
 * smaller roster is a smaller transfer — which is the real cost on a relayed
 * link. Dependencies declared through `inject` are kept transitively.
 */
function trimBoot(html, dropIds) {
  if (!Array.isArray(dropIds) || dropIds.length === 0) return html
  const marker = 'globalThis["__DSH_BOOT__"]'
  const at = html.indexOf(marker)
  if (at < 0) return html
  const start = html.indexOf('{', at)
  if (start < 0) return html
  let depth = 0
  let end = -1
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return html
  let boot
  try {
    boot = JSON.parse(html.slice(start, end))
  } catch {
    return html
  }
  if (!Array.isArray(boot.entries)) return html
  const byId = new Map(boot.entries.map((entry) => [entry.id, entry]))
  const drop = new Set(dropIds)
  const keep = new Set()
  const visit = (id) => {
    if (keep.has(id) || !byId.has(id)) return
    keep.add(id)
    for (const dep of byId.get(id).inject ?? []) visit(dep)
  }
  for (const entry of boot.entries) if (!drop.has(entry.id)) visit(entry.id)
  boot.entries = boot.entries.filter((entry) => keep.has(entry.id))
  return html.slice(0, start) + JSON.stringify(boot) + html.slice(end)
}

function brHeaders(source, rawLength, compressedLength) {
  const out = { ...source }
  out['content-encoding'] = 'br'
  out['content-length'] = String(compressedLength)
  out['x-gw-bytes'] = `${rawLength}->${compressedLength}`
  delete out['transfer-encoding']
  delete out.etag
  return out
}

const baseName = (path) => (typeof path === 'string' ? (path.split('/').filter(Boolean).pop() ?? path) : '')

function mobilePage(res) {
  try {
    const body = readFileSync(path.join(PACKAGE_ROOT, 'lib', 'page.html'))
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    }).end(body)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      .end('mobile.html missing: ' + error.message)
  }
}

const userFacing = (message) => {
  const error = new Error(message)
  error.userMessage = message
  return error
}

/** Vendored mermaid, served pre-compressed so the phone only pays for it once. */
function mermaidAsset(req, res) {
  const accept = String(req.headers['accept-encoding'] ?? '')
  const variants = accept.includes('br')
    ? [['br', 'mermaid.min.js.br'], ['gzip', 'mermaid.min.js.gz'], [null, 'mermaid.min.js']]
    : accept.includes('gzip')
      ? [['gzip', 'mermaid.min.js.gz'], [null, 'mermaid.min.js']]
      : [[null, 'mermaid.min.js']]
  for (const [encoding, file] of variants) {
    try {
      const body = readFileSync(path.join(PACKAGE_ROOT, 'assets', file))
      const headers = {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(body.length),
      }
      if (encoding !== null) headers['content-encoding'] = encoding
      else headers.vary = 'accept-encoding'
      res.writeHead(200, headers).end(body)
      return
    } catch {}
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('asset missing')
}

function mobileJson(res, work) {
  Promise.resolve()
    .then(work)
    .then((data) => {
      const body = JSON.stringify(data)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      }).end(body)
    })
    .catch((error) => {
      // Internal detail (paths, session ids, stack text) stays in the host log;
      // the phone only ever sees a message written for a person.
      const text = String(error?.message ?? error)
      let message = error?.userMessage
      if (message === undefined) {
        if (/not found|unknown session|session .* not found/i.test(text)) message = '会话不存在或已被删除'
        else if (/unavailable|not ready/i.test(text)) message = '宿主还没准备好，稍后再试'
        else if (/aborted|timeout/i.test(text)) message = '操作超时了，再试一次'
        else message = '操作失败，请重试'
      }
      if (error?.userMessage === undefined) console.log(`[dsh-mobi-web] request failed: ${text}`)
      const status = error?.userMessage !== undefined ? 400
        : /not found|unknown session/i.test(text) ? 404
        : 500
      const body = JSON.stringify({ error: message })
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(body)
    })
}

function statsPage(res, recent, counters, approvals) {
  const safe = approvals === undefined
    ? undefined
    : { ...approvals, lastError: approvals.lastError === null ? null : 'present' }
  const body = JSON.stringify({ counters, approvals: safe, recent }, null, 2)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
}

function redirectLoopPage(res) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 登录被浏览器拦截</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#e9ebf0;
font:14px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif;padding:28px;box-sizing:border-box}
div{max-width:360px}h1{font-size:17px;margin:0 0 12px}code{background:#16191f;padding:2px 6px;border-radius:5px}
p{color:#9aa2ae;margin:0 0 12px}</style></head><body><div>
<h1>登录被浏览器拦截了</h1>
<p>这台设备没能保存 DSH 的会话 cookie，于是重定向了太多次。</p>
<p>请清除 <code id="site"></code> 的网站数据后再打开；或者换 Safari 试试。</p>
<p>如果仍然不行，说明网关的会话交换失败了，看 Mac 上的 <code>[dsh-mobi-web]</code> 日志。</p>
</div>
<script>document.getElementById('site').textContent = location.host</script>
</body></html>`
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    .end(body)
}

function tooMany(res) {
  res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' })
    .end('尝试次数过多，请一分钟后再试。\n')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) return reject(new Error('body too large'))
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function challenge(res, status, message) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>DSH 远程访问</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(600px 420px at 50% 22%,#16203c 0%,#0b0c0e 70%);color:#e9ebf0;
font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;padding:24px;box-sizing:border-box}
.card{width:100%;max-width:340px;text-align:center}
.mark{width:56px;height:56px;border-radius:17px;margin:0 auto 20px;background:linear-gradient(150deg,#5b78ff,#3547b8);display:grid;place-items:center;box-shadow:0 10px 30px rgba(77,107,254,.35)}
h1{font-size:19px;margin:0 0 6px;font-weight:600}
p.sub{margin:0;color:#8b93a1;font-size:12px}
form{margin-top:28px}
input{width:100%;height:48px;border-radius:13px;border:1px solid #2b3038;background:#15181d;color:#e9ebf0;
font-size:16px;padding:0 14px;box-sizing:border-box;outline:none}
input:focus{border-color:#4d6bfe}
button{width:100%;height:48px;margin-top:12px;border:0;border-radius:13px;background:#4d6bfe;color:#fff;
font-size:16px;font-weight:600}
.err{margin-top:12px;color:#e2706b;font-size:12px;min-height:18px}
.foot{margin-top:24px;color:#4e5560;font-size:11px}
</style></head><body><div class="card">
<div class="mark"><svg width="30" height="30" viewBox="0 0 24 24" fill="none">
<path d="M3 9c3.6 0 5.4-3 9-3s5.4 3 9 3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
<path d="M3 15c3.6 0 5.4-3 9-3s5.4 3 9 3" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".65"/>
<circle cx="12" cy="19.5" r="1.3" fill="#fff" opacity=".9"/></svg></div>
<h1>远程访问</h1><p class="sub">DeepSeek Harness · dsh-mobi-web</p>
<form method="post" action="/__gw/login">
<input type="password" name="p" placeholder="访问密码" autocomplete="current-password" autofocus>
<button type="submit">进入</button></form>
<div class="err">${escapeHtml(message)}</div>
<div class="foot">仅本人设备 · 会话与电脑实时同步</div>
</div></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  }).end(body)
}

function manifest(res) {
  const body = JSON.stringify({
    name: 'DSH',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0c0e',
    theme_color: '#0b0c0e',
    icons: [
      { src: '/__gw/icon.png', sizes: '360x360', type: 'image/png', purpose: 'any' },
      { src: '/__gw/icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  })
  res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' }).end(body)
}

let iconCache
function icon(res, file = new URL('./asset/icon.png', import.meta.url)) {
  try {
    iconCache ??= readFileSync(file)
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }).end(iconCache)
  } catch {
    res.writeHead(404).end()
  }
}

/* ── cordis entry ──────────────────────────────────────────────────────── */

/** A stranger installing this bundle gets a working gate without editing YAML:
 *  with no token configured we mint one once and keep it in $DSH_HOME.
 *  Returns the token *and* where it came from, because the caller has to be
 *  able to say which file holds it — a freshly minted token that nobody can
 *  find is the same as no token at all. */
export function resolveToken(configured) {
  if (configured === false) return { token: '', source: 'disabled' }
  if (typeof configured === 'string' && configured !== '') return { token: configured, source: 'config' }
  const file = path.join(DSH_HOME, 'dsh-mobi-web-token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return { token: existing, source: 'file', file }
  } catch {}
  const minted = crypto.randomBytes(16).toString('hex')
  let saved = false
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(file, minted + '\n', { mode: 0o600 })
    saved = true
  } catch {}
  return { token: minted, source: 'minted', file, saved }
}

/**
 * Pending approvals from a session surface that the gateway does not own.
 * `approval/asked` without a matching `approval/decided`; owned asks are
 * filtered because those already render as an actionable card. Pure so the
 * read path stays testable without a cordis host.
 */
export function pendingApprovalsFromEvents(events, isOwned = () => false) {
  const pending = new Map()
  for (const event of events ?? []) {
    const id = String(event?.data?.id ?? '')
    if (id === '') continue
    if (event?.type === 'approval/asked') {
      if (!isOwned(id) && !pending.has(id)) {
        pending.set(id, {
          id,
          toolName: event.data?.toolName ?? 'tool',
          reason: event.data?.reason,
          at: typeof event.time === 'number' ? event.time : undefined,
        })
      }
    } else if (event?.type === 'approval/decided') {
      pending.delete(id)
    }
  }
  return [...pending.values()]
}

/**
 * Build and admit one phone prompt.
 *
 * `sessionController.prompt()` is the admission boundary. It resumes a cold
 * session itself, validates the content and attachments, and resolves only
 * after the Agent has taken the message into its inbox. It is **not** a
 * transcript receipt: a prompt sent while a turn is already running waits in
 * `inbox.nextTurn` and only becomes a `user/message` event when the next turn
 * starts — which can be minutes later. Polling the session surface for that
 * event (which this gateway used to do) rejected correctly queued messages, so
 * the phone showed "发送失败" and every retry queued another copy. Trust the
 * admission result instead.
 *
 * `requestId` is the client's retry key. Reusing it on a retry lets the
 * controller recognise the prompt it already admitted (`hasPromptRequest`)
 * instead of queueing a second copy.
 */
export function createPromptAdmission({ getController, timeoutMs = 60_000, onRequest } = {}) {
  return async function admitPrompt(id, text, images, requestId) {
    let controller
    try { controller = getController?.() } catch { controller = undefined }
    if (typeof controller?.prompt !== 'function') throw new Error('sessionController unavailable')
    if (typeof id !== 'string' || id === '') throw userFacing('缺少会话标识')

    const value = String(text ?? '').trim()
    const parts = []
    if (value !== '') parts.push({ type: 'text', text: value })
    for (const image of Array.isArray(images) ? images.slice(0, 4) : []) {
      if (typeof image?.data !== 'string' || image.data === '') continue
      if (typeof image?.mediaType !== 'string' || !image.mediaType.startsWith('image/')) continue
      parts.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
    }
    if (parts.length === 0) throw userFacing('消息不能为空')

    // A client id is only a retry key; keep it inside one predictable namespace
    // and mint a fresh one for callers that do not send it (older page builds).
    const retryKey = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(requestId)
      ? requestId
      : crypto.randomUUID()
    const rpcId = 'm-' + retryKey
    const request = {
      requestId: rpcId,
      sessionId: id,
      mode: 'queue',
      content: parts,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    // Register before admission: the Agent may commit the message in a
    // microtask, and a caller that times out still needs the retry key traced.
    try { onRequest?.(id, rpcId) } catch {}

    const abort = new AbortController()
    let timer
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(userFacing('发送超时了，消息可能已经在队列里；重试不会重复发'))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([controller.prompt(request, abort.signal), timedOut])
      if (result?.accepted === false) throw userFacing('消息没有进入会话，请重试')
      return { result: result ?? { accepted: true }, requestId: rpcId }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const resolved = config.token === false
    ? { token: '', source: 'disabled' }
    : typeof config.token === 'string' && config.token !== ''
      ? { token: config.token, source: 'config' }
      : String(process.env[config.tokenEnv] || '') !== ''
        ? { token: String(process.env[config.tokenEnv]), source: 'env' }
        : resolveToken(undefined)
  const token = resolved.token
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-mobi-web') : undefined
  // cordis' logger keeps messages in a ring buffer and exports them nowhere
  // by default, so a logger-only line is invisible in a plain `dsh web` boot —
  // exactly where the entrance URL and the token path have to be seen. Print
  // every line and mirror it into ctx.logger for hosts that do export it.
  // The logger call is guarded: it runs inside the host process, and an
  // uncaught throw from it is fatal to the host.
  const say = (level, ...args) => {
    const line = `[dsh-mobi-web] ${args.join(' ')}`
    if (level === 'error') console.error(line)
    else console.log(line)
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, ...args)
    } catch {}
  }

  const getUpstream = () => ({
    host: config.upstreamHost,
    port: config.upstreamPort || ctx.webServer.port,
  })

  const getLaunchPath = () => {
    try {
      const connection = ctx.get?.('connection')
      if (!connection?.authenticatedUrl) return null
      const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`))
      return url.pathname + url.search
    } catch {
      return null
    }
  }

  // Exchange the harness launch token for its browser-session cookie, once per
  // upstream port, and replay it from the gateway. The phone then needs no
  // harness cookie of its own, which is what breaks the redirect loop on iOS.
  const sessions = new Map()
  const ensureSession = async (port) => {
    const hit = sessions.get(port)
    if (hit) return hit
    const connection = ctx.get?.('connection')
    if (!connection?.authenticatedUrl) return null
    const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${port}/`))
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    })
    const raw = response.headers.getSetCookie?.() ?? []
    const pair = raw.map((one) => one.split(';')[0]).find((one) => one.includes('='))
    if (!pair) return null
    sessions.set(port, pair)
    return pair
  }
  const invalidateSession = (port) => sessions.delete(port)

  const mobileQuery = () => {
    try { return ctx.get?.('sessionQuery') } catch { return undefined }
  }
  // 4k used to be the cap here, which silently cut long answers mid-sentence.
  // Keep a generous per-message ceiling and bound the response by total size
  // instead, so a chatty turn cannot blow up the phone's payload either.
  const MESSAGE_CHAR_LIMIT = 40_000
  const SESSION_CHAR_BUDGET = 120_000
  const textOf = (content) => {
    if (!Array.isArray(content)) return ''
    const text = content.map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (part?.type === 'image') return '[图片]'
      return ''
    }).join('').trim()
    if (text.length <= MESSAGE_CHAR_LIMIT) return text
    return text.slice(0, MESSAGE_CHAR_LIMIT) + '\n\n…（这条消息过长，后面还有 ' + (text.length - MESSAGE_CHAR_LIMIT) + ' 个字符未显示）'
  }
  const titleOf = (row) => {
    const candidates = [row?.title, row?.snapshot?.title, row?.value?.title, row?.titleSnapshot?.title]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
      if (candidate !== null && typeof candidate === 'object' &&
          typeof candidate.title === 'string' && candidate.title.trim() !== '') return candidate.title.trim()
    }
    return undefined
  }
  const updatedOf = (row) => {
    const candidates = [row?.updatedAt, row?.snapshot?.updatedAt, row?.title?.updatedAt, row?.value?.updatedAt]
    return candidates.find((value) => typeof value === 'number')
  }

  // M3b (phone-first): the approval waterfall is serial, so we answer before the
  // desktop only while the phone is actually watching this session, and hand the
  // request back through next() after a timeout. Nothing is lost when nobody taps.
  // L1: push committed session events to the phone over SSE instead of polling.
  const streams = new Map()
  const runningSessions = new Set()
  // Approvals the gateway owns (the phone may answer) and approvals the host has
  // asked for that it does not own (the desktop is answering). The second map is
  // what lets the phone show "PC is waiting" instead of a silent stuck turn.
  const approvals = new Map()
  const pendingApprovals = new Map()
  const seenSessions = new Map()
  // Sessions whose current turn was started by the phone. A prompt is only
  // "this turn's origin" once its message is committed: a prompt queued behind
  // a running turn must not make the current (desktop-started) turn phone-owned.
  const phoneTurns = new Set()
  // rpcIds of phone prompts that have been admitted but not yet seen as a
  // `user/message` event. Bounded because a queued prompt can outlive a turn.
  const phoneRequests = new Map()
  const trackPhoneRequest = (sessionId, rpcId) => {
    let pending = phoneRequests.get(sessionId)
    if (pending === undefined) { pending = new Set(); phoneRequests.set(sessionId, pending) }
    pending.add(rpcId)
    while (pending.size > 20) pending.delete(pending.values().next().value)
  }
  // One admission path for the page and any future caller: the controller is
  // looked up per call (the service can mount after this plugin), and the
  // request id is traced so a queued prompt can claim its turn later.
  const admitPrompt = createPromptAdmission({
    getController: () => ctx.get?.('sessionController'),
    onRequest: trackPhoneRequest,
  })
  const pushEvent = (sessionId, payload) => {
    const set = streams.get(sessionId)
    if (set === undefined || set.size === 0) return
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of set) { try { res.write(line) } catch {} }
  }
  const desktopApprovalsFor = (sessionId) => [...pendingApprovals.values()]
    .filter((entry) => entry.sessionId === sessionId && !approvals.has(entry.id))
  const approvalStatusPayload = (sessionId) => {
    const list = desktopApprovalsFor(sessionId)
    const first = list[0]
    return {
      kind: 'approval-status',
      count: list.length,
      toolName: first?.toolName,
      reason: first?.reason,
      at: first?.at,
    }
  }
  const pushApprovalStatus = (sessionId) => {
    if (sessionId === undefined) return
    pushEvent(sessionId, approvalStatusPayload(sessionId))
  }
  const openStream = (req, res, sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('session required')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    let set = streams.get(sessionId)
    if (set === undefined) { set = new Set(); streams.set(sessionId, set) }
    set.add(res)
    res.write(`data: ${JSON.stringify({ kind: 'state', running: runningSessions.has(sessionId) })}\n\n`)
    res.write(`data: ${JSON.stringify(approvalStatusPayload(sessionId))}\n\n`)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
    const close = () => {
      clearInterval(ping)
      set.delete(res)
      if (set.size === 0) streams.delete(sessionId)
    }
    req.on('close', close)
    res.on('close', close)
  }

  try {
    // L2: token-level publication from the agent attempt (transient frames).
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let sessionId
      try { sessionId = agent?.session?.id ?? agent?.id } catch {}
      if (sessionId === undefined || !streams.has(sessionId)) return
      if (frame?.type === 'start') { runningSessions.add(sessionId); pushEvent(sessionId, { kind: 'astart' }); return }
      if (frame?.type === 'end') { pushEvent(sessionId, { kind: 'aend' }); return }
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        pushEvent(sessionId, { kind: 'adelta', text: chunk.text })
      }
    })
  } catch (error) {
    say('warn', `assistant stream unavailable: ${error.message}`)
  }

  try {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id
      if (sessionId !== undefined) {
        // Track every ask, including the ones the gateway deliberately delegates
        // to the desktop UI. `desktopApprovalsFor()` filters out the ones the
        // gateway owns, so the phone shows a read-only status only when the
        // desktop is the one being waited on.
        if (event?.type === 'approval/asked') {
          const id = String(event.data?.id ?? '')
          if (id !== '') {
            pendingApprovals.set(id, {
              id,
              sessionId,
              toolName: event.data?.toolName ?? 'tool',
              reason: event.data?.reason,
              callId: event.data?.callId,
              at: typeof event.time === 'number' ? event.time : Date.now(),
            })
            pushApprovalStatus(sessionId)
          }
        } else if (event?.type === 'approval/decided') {
          pendingApprovals.delete(String(event.data?.id ?? ''))
          pushApprovalStatus(sessionId)
        } else if (event?.type === 'turn/end') {
          runningSessions.delete(sessionId)
          // Clear here, not only on the streaming path: the phone is often
          // locked (no stream) when the turn ends, and a stale entry would make
          // the next desktop-started turn look phone-owned.
          phoneTurns.delete(sessionId)
          for (const [pendingId, pending] of pendingApprovals) {
            if (pending.sessionId === sessionId) pendingApprovals.delete(pendingId)
          }
          pushApprovalStatus(sessionId)
        } else if (event?.type === 'turn/start') {
          runningSessions.add(sessionId)
        } else if (event?.type === 'user/message') {
          // A phone prompt becomes the origin of a turn only when its message
          // is actually committed. Matching the rpcId (rather than "some user
          // message appeared") keeps a prompt queued behind a desktop turn
          // from claiming that turn's approvals.
          const rpcId = event.data?.source?.rpcId
          const pending = phoneRequests.get(sessionId)
          if (pending !== undefined && typeof rpcId === 'string' && pending.delete(rpcId)) {
            phoneTurns.add(sessionId)
            if (pending.size === 0) phoneRequests.delete(sessionId)
          }
        }
      }
      if (sessionId === undefined || !streams.has(sessionId)) return
      if (event?.type === 'turn/start') pushEvent(sessionId, { kind: 'state', running: true })
      else if (event?.type === 'turn/end') pushEvent(sessionId, { kind: 'state', running: false })
      else if (event?.type === 'user/message') {
        const text = textOf(event.data?.content)
        if (text !== '') pushEvent(sessionId, { kind: 'message', role: 'user', text })
      } else if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text !== '') pushEvent(sessionId, { kind: 'message', role: 'assistant', text })
      } else if (event?.type === 'tool/result') {
        pushEvent(sessionId, { kind: 'tool' })
      }
    })
  } catch (error) {
    say('warn', `session event stream unavailable: ${error.message}`)
  }

  const approvalStats = { events: 0, taken: 0, delegated: 0, cancelled: 0, errors: 0, archived: 0, lastSession: null, lastSeenAgeMs: null, lastOrigin: null, lastError: null }
  const APPROVAL_WINDOW_MS = 30_000
  const APPROVAL_STALE_MS = 10_000
  const APPROVAL_GRACE_MS = 20_000
  const PHONE_APPROVAL_MAX_MS = 15 * 60_000
  const PHONE_APPROVAL_QUIET_MS = 60_000
  const APPROVAL_MAX_MS = 90_000
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // prepend: the waterfall is serial, so we must run before the desktop UI's
    // answerer to get a shot at the request. We delegate immediately when the
    // phone is not watching, so the desktop behaviour is unchanged in that case.
    ctx.on('approval/request', async (request, next) => {
      approvalStats.events += 1
      if (config.approvalPriority !== 'phone-first') { approvalStats.delegated += 1; return next() }
      let sessionId
      try { sessionId = request?.agent?.session?.id ?? request?.agent?.id } catch (error) { approvalStats.errors += 1; approvalStats.lastError = String(error) }
      approvalStats.lastSession = sessionId === undefined ? null : String(sessionId)
      const lastSeen = sessionId === undefined ? 0 : (seenSessions.get(sessionId) ?? 0)
      approvalStats.lastSeenAgeMs = sessionId === undefined ? null : Date.now() - lastSeen

      // A turn that the phone started belongs to the phone: delegating it to a
      // desktop nobody is sitting at only moves the deadlock. Desktop-origin
      // turns keep the old hand-back behaviour.
      const fromPhone = sessionId !== undefined && phoneTurns.has(sessionId)
      approvalStats.lastOrigin = fromPhone ? 'phone' : 'desktop'
      const id = String(request?.id ?? request?.callId ?? crypto.randomUUID())
      if (!pendingApprovals.has(id)) {
        pendingApprovals.set(id, {
          id, sessionId, toolName: request?.toolName ?? 'tool', reason: request?.reason,
          callId: request?.callId, at: Date.now(),
        })
      }
      if (!fromPhone && Date.now() - lastSeen > APPROVAL_WINDOW_MS) {
        approvalStats.delegated += 1
        pushApprovalStatus(sessionId)
        return next()
      }
      let settle
      const decision = new Promise((resolve) => { settle = resolve })
      approvals.set(id, {
        id, sessionId, toolName: request?.toolName ?? 'tool', reason: request?.reason,
        at: Date.now(), origin: fromPhone ? 'phone' : 'desktop', settle,
      })
      pushEvent(sessionId, { kind: 'approval', id, toolName: request?.toolName ?? 'tool', reason: request?.reason })
      approvalStats.taken += 1

      const startedAt = Date.now()
      let settled = false
      let outcome = null
      decision.then((value) => { outcome = value; settled = true })
      const reachable = () => streams.has(sessionId) || Date.now() - (seenSessions.get(sessionId) ?? 0) < 30_000

      if (fromPhone) {
        // Hold for the full ceiling regardless of whether the phone is currently
        // reachable: iOS suspends the page on lock, but the pending approval is
        // re-delivered the moment it reconnects (open → session payload). Only
        // the ceiling can end it.
        while (!settled && Date.now() - startedAt < PHONE_APPROVAL_MAX_MS) {
          await sleep(2000)
        }
        approvalStats.lastHeldMs = Date.now() - startedAt
        try {
          if (!settled || outcome === null) {
            approvalStats.cancelled += 1
            pushEvent(sessionId, { kind: 'approval-done', id })
            return 'cancelled'
          }
          return outcome
        } finally {
          approvals.delete(id)
          pendingApprovals.delete(id)
          pushApprovalStatus(sessionId)
        }
      }

      // Desktop-origin: short grace, then hand back to the desktop UI.
      while (!settled && Date.now() - startedAt < APPROVAL_MAX_MS) {
        await sleep(2000)
        if (settled) break
        if (Date.now() - lastSeen > APPROVAL_STALE_MS && Date.now() - startedAt > APPROVAL_GRACE_MS) break
      }
      approvalStats.lastHeldMs = Date.now() - startedAt
      try {
        if (!settled || outcome === null) {
          approvalStats.delegated += 1
          // The card the phone was showing is now stale: the desktop owns the
          // request. Drop our ownership BEFORE publishing the status, otherwise
          // the status still counts this id as phone-owned and reports zero.
          approvals.delete(id)
          pushEvent(sessionId, { kind: 'approval-done', id })
          pushApprovalStatus(sessionId)
          return next()
        }
        return outcome
      } finally {
        approvals.delete(id)
        if (settled) {
          pendingApprovals.delete(id)
          pushApprovalStatus(sessionId)
        }
      }
    }, true)
  } catch (error) {
    say('warn', `approval listener unavailable: ${error.message}`)
  }

  const listCache = { at: 0, value: null }
  const mobile = {
    async list() {
      if (listCache.value !== null && Date.now() - listCache.at < 10_000) return listCache.value
      const query = mobileQuery()
      if (typeof query?.listSessions !== 'function') return { workspaces: [], error: 'sessionQuery unavailable' }

      // sessionController.list is the same source the desktop sidebar orders by:
      // SessionSummary.updatedAt is the durable message time, so the phone shows
      // the same order as the desktop instead of creation order.
      const summaries = new Map()
      try {
        const controller = ctx.get?.('sessionController')
        if (typeof controller?.list === 'function') {
          const value = await controller.list({}, AbortSignal.timeout(8000))
          for (const item of value?.items ?? []) summaries.set(item.sessionId, item)
        }
      } catch (error) {
        say('warn', `session list unavailable: ${error.message}`)
      }

      const records = await query.listSessions()
      const titles = new Map()
      try {
        if (typeof query.readTitleSnapshots === 'function') {
          for (const row of await query.readTitleSnapshots(records.map((r) => r.header.id))) {
            const id = row?.sessionId ?? row?.id ?? row?.session?.id
            const title = titleOf(row)
            if (id !== undefined && title !== undefined) titles.set(id, title)
          }
        }
      } catch {}

      const byId = new Map()
      for (const record of records) {
        const id = record.header.id
        const summary = summaries.get(id)
        byId.set(id, {
          id,
          title: titles.get(id),
          cwd: summary?.cwd ?? record.header.cwd,
          updatedAt: summary?.updatedAt ?? record.header.createdAt,
          running: summary?.running === true,
          waiting: desktopApprovalsFor(id).length > 0,
          live: summary?.agentAvailable ?? record.live === true,
          blank: summary?.blank === true,
        })
      }

      let registry
      try { registry = ctx.get?.('workspaceRegistry') } catch { registry = undefined }

      const archived = new Set()
      try {
        for (const id of registry?.archivedSessionIds ?? []) archived.add(id)
      } catch {}
      approvalStats.archived = archived.size

      const groups = []
      const grouped = new Set()
      if (typeof registry?.list === 'function') {
        for (const workspace of registry.list()) {
          const ids = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).filter((id) => !archived.has(id))
          const sessions = ids.map((id) => byId.get(id)).filter(Boolean)
          for (const session of sessions) grouped.add(session.id)
          sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          groups.push({
            id: workspace.id,
            title: workspace.title ?? baseName(workspace.path),
            path: workspace.path,
            sessions,
          })
        }
      }

      const loose = [...byId.values()].filter((session) => !grouped.has(session.id) && !archived.has(session.id))
      if (loose.length > 0) {
        const byCwd = new Map()
        for (const session of loose) {
          const key = session.cwd ?? ''
          if (!byCwd.has(key)) byCwd.set(key, [])
          byCwd.get(key).push(session)
        }
        for (const [cwd, sessions] of byCwd) {
          sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          groups.push({ id: 'cwd:' + cwd, title: baseName(cwd) || '未分组', path: cwd, sessions })
        }
      }

      const merged = new Map()
      for (const group of groups) {
        const key = group.path ?? group.id
        const existing = merged.get(key)
        if (existing === undefined) { merged.set(key, group); continue }
        const seen = new Set(existing.sessions.map((session) => session.id))
        for (const session of group.sessions) if (!seen.has(session.id)) existing.sessions.push(session)
        existing.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      }
      const folded = [...merged.values()]
      folded.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))

      const value = { workspaces: folded }
      listCache.at = Date.now()
      listCache.value = value
      return value
    },

    async create(cwd) {
      let controller
      try { controller = ctx.get?.('sessionController') } catch { controller = undefined }
      if (typeof controller?.create !== 'function') throw new Error('sessionController unavailable')
      // A phone "＋" sends the workspace directory, but sessionController.create
      // only joins a Workspace when it receives a workspaceId — a cwd-only
      // create lands in "Ungrouped" on the desktop and the phone's list hides
      // that by regrouping loose sessions by cwd. Resolve the directory first.
      let workspaceId
      if (typeof cwd === 'string' && cwd !== '') {
        try {
          const registry = ctx.get?.('workspaceRegistry')
          const workspace = await registry?.resolveByPath?.(cwd)
          workspaceId = workspace?.id
        } catch {}
      }
      const request = workspaceId !== undefined
        ? { workspaceId }
        : (typeof cwd === 'string' && cwd !== '' ? { cwd } : {})
      const value = await controller.create(request)
      listCache.at = 0
      return value ?? {}
    },

    async prompt(id, text, images, requestId) {
      const admitted = await admitPrompt(id, text, images, requestId)
      return admitted.result
    },

    async cancel(id) {
      let controller
      try { controller = ctx.get?.('sessionController') } catch { controller = undefined }
      if (typeof controller?.cancel !== 'function') throw new Error('sessionController unavailable')
      if (typeof id !== 'string' || id === '') throw userFacing('缺少会话标识')
      return controller.cancel({ sessionId: id })
    },

    async resolve(id, decision) {
      const entry = approvals.get(id)
      if (entry === undefined) throw userFacing('这个审批已经处理过了')
      const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
      entry.settle(outcome)
      approvals.delete(id)
      pendingApprovals.delete(id)
      pushApprovalStatus(entry.sessionId)
      pushEvent(entry.sessionId, { kind: 'approval-done', id })
      return { ok: true, outcome }
    },

    async read(id) {
      const query = mobileQuery()
      if (typeof query?.readSurface !== 'function') return { messages: [], error: 'sessionQuery unavailable' }
      if (typeof id !== 'string' || id === '') throw userFacing('缺少会话标识')
      seenSessions.set(id, Date.now())
      const snapshot = await query.readSurface(id)
      let title
      try { title = titleOf(await query.readTitleSnapshot(id)) } catch {}
      const messages = []
      let tools = 0
      const flushTools = () => {
        if (tools > 0) { messages.push({ role: 'tool', text: tools + ' 个工具调用' }); tools = 0 }
      }
      for (const event of snapshot?.events ?? []) {
        if (event?.type === 'user/message') {
          flushTools()
          const text = textOf(event.data?.content)
          if (text !== '') messages.push({ role: 'user', text })
        } else if (event?.type === 'assistant/message') {
          flushTools()
          const text = textOf(event.data?.message?.content)
          if (text !== '') messages.push({ role: 'assistant', text })
        } else if (event?.type === 'tool/result') {
          tools += 1
        }
      }
      flushTools()
      const pending = [...approvals.values()]
        .filter((entry) => entry.sessionId === id)
        .map((entry) => ({ id: entry.id, toolName: entry.toolName, reason: entry.reason, at: entry.at }))
      // Approvals that belong to the desktop (or were delegated to it). The live
      // map is the fast path; the surface scan covers a gateway restart and a
      // reconnect where the ask event happened before this process started.
      const desktop = new Map()
      for (const entry of desktopApprovalsFor(id)) desktop.set(entry.id, entry)
      const decided = new Set()
      for (const event of snapshot?.events ?? []) {
        if (event?.type === 'approval/decided') decided.add(String(event.data?.id ?? ''))
      }
      for (const approvalId of decided) desktop.delete(approvalId)
      for (const entry of pendingApprovalsFromEvents(snapshot?.events, (approvalId) => approvals.has(approvalId))) {
        if (!desktop.has(entry.id)) desktop.set(entry.id, { ...entry, sessionId: id })
      }
      const desktopApprovals = [...desktop.values()]
        .map(({ id: approvalId, toolName, reason, at }) => ({ id: approvalId, toolName, reason, at }))
      // Newest first while budgeting, then restore chronological order.
      const budgeted = []
      let total = 0
      for (let index = messages.length - 1; index >= 0 && budgeted.length < 40; index -= 1) {
        const message = messages[index]
        if (budgeted.length > 0 && total + message.text.length > SESSION_CHAR_BUDGET) break
        total += message.text.length
        budgeted.unshift(message)
      }
      return { id, title, cwd: snapshot?.session?.cwd, messages: budgeted, approvals: pending, desktopApprovals }
    },
  }

  let gateway
  try {
    gateway = createGateway({
      ...config,
      token,
      getUpstream,
      getLaunchPath,
      mobile,
      openStream,
      approvalStats,
      ensureSession,
      invalidateSession,
      log: (...args) => say('warn', ...args),
    })
  } catch (error) {
    say('error', error.message)
    return
  }

  ctx.effect(() => {
    let disposed = false
    gateway.listen().then(
      (address) => {
        if (disposed) return
        const where = `${String(config.listenHost)}:${address?.port ?? config.listenPort}`
        say('info', `listening on ${where} → 127.0.0.1:${ctx.webServer.port}${token ? ' (token required)' : ''}`)
        // Say where the password is. The token itself stays out of the log —
        // it is one shared secret that grants the whole machine — except in
        // the one case where it exists nowhere else.
        if (resolved.source === 'minted') {
          if (resolved.saved) {
            say('warn', `no token was configured, so one was minted and saved to ${resolved.file} (mode 0600)`)
            say('warn', `read it with: cat ${resolved.file}`)
          } else {
            say('warn', `no token was configured and ${resolved.file} could not be written — this run's token is ${token}`)
            say('warn', 'it is not saved: set config.token, or make $DSH_HOME writable')
          }
        } else if (resolved.source === 'file') {
          say('info', `token read from ${resolved.file}`)
        }
        if (!token) say('warn', 'no token configured — the page is open to anyone who can reach the port')
        else if (config.listenHost === '127.0.0.1') say('info', `open http://127.0.0.1:${config.listenPort}/m/ on the phone through your tunnel`)
        else say('info', `open http://${where}/m/`)
      },
      (error) => {
        say('error', `failed to listen on ${config.listenHost}:${config.listenPort}: ${error.message}`)
      },
    )
    return () => {
      disposed = true
      return gateway.close()
    }
  })
}

// Cordis also accepts an object plugin; shipping both forms keeps the bundle
// loadable by every DSH release that has shipped so far.
export default { name, inject, apply }
