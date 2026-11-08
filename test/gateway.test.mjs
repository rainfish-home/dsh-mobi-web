import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { createGateway } from '../lib/index.js'

const startUpstream = (handler) => new Promise((resolve) => {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      `upgrade: ${req.headers.upgrade ?? 'websocket'}\r\n` +
      'connection: Upgrade\r\n' +
      `x-upstream-host: ${req.headers.host}\r\n\r\n`,
    )
  })
  server.listen(0, '127.0.0.1', () => {
    const close = () => new Promise((r) => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close(() => r())
      server.closeAllConnections?.()
    })
    resolve({ port: server.address().port, server, close })
  })
})

const gatewayFor = async (upstreamPort, options = {}) => {
  const gw = createGateway({
    listenPort: 0,
    getUpstream: () => ({ host: '127.0.0.1', port: upstreamPort }),
    ...options,
  })
  await gw.listen()
  return gw
}

test('rewrites Host and Origin to the loopback upstream', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url }))
  })
  const gw = await gatewayFor(up.port)

  const res = await fetch(`http://127.0.0.1:${gw.port()}/api/x?y=1`, {
    headers: { origin: 'https://dsh.example.com' },
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.host, `127.0.0.1:${up.port}`)
  assert.equal(body.origin, `http://127.0.0.1:${up.port}`)
  assert.equal(body.url, '/api/x?y=1')

  await gw.close(); await up.close()
})

test('streams the request body and the upstream status', async () => {
  const up = await startUpstream(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.writeHead(418, { 'content-type': 'text/plain' })
    res.end(`got:${Buffer.concat(chunks).toString('utf8')}`)
  })
  const gw = await gatewayFor(up.port)

  const res = await fetch(`http://127.0.0.1:${gw.port()}/echo`, { method: 'POST', body: 'hello' })
  assert.equal(res.status, 418)
  assert.equal(await res.text(), 'got:hello')

  await gw.close(); await up.close()
})

test('token gate: the password form is the only door', async () => {
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('app')
  })
  const gw = await gatewayFor(up.port, { token: 's3cret' })
  const base = `http://127.0.0.1:${gw.port()}`

  const denied = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(denied.status, 401)
  assert.match(await denied.text(), /远程访问/)

  // A launch token in the URL is off by default: it leaks via history.
  const viaUrl = await fetch(`${base}/?t=s3cret`, { redirect: 'manual' })
  assert.equal(viaUrl.status, 401)

  const login = await fetch(`${base}/__gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=s3cret',
    redirect: 'manual',
  })
  assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')
  assert.match(cookie, /dshgw=/)
  assert.match(cookie, /HttpOnly/)

  const allowed = await fetch(`${base}/`, { headers: { cookie: cookie.split(';')[0] } })
  assert.equal(allowed.status, 200)
  assert.equal(await allowed.text(), 'app')

  await gw.close(); await up.close()
})

test('allowTokenUrl restores the one-shot link', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200).end('app') })
  const gw = await gatewayFor(up.port, { token: 's3cret', allowTokenUrl: true })
  const res = await fetch(`http://127.0.0.1:${gw.port()}/?t=s3cret`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.match(res.headers.get('set-cookie'), /dshgw=/)
  await gw.close(); await up.close()
})

test('token gate: the login form posts the password', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200).end('app') })
  const gw = await gatewayFor(up.port, { token: 's3cret' })
  const base = `http://127.0.0.1:${gw.port()}`

  const bad = await fetch(`${base}/__gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=wrong',
    redirect: 'manual',
  })
  assert.equal(bad.status, 401)

  const ok = await fetch(`${base}/__gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=s3cret',
    redirect: 'manual',
  })
  assert.equal(ok.status, 302)
  assert.match(ok.headers.get('location'), /^\//)

  await gw.close(); await up.close()
})

test('health stays open even with a token configured', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200).end('app') })
  const gw = await gatewayFor(up.port, { token: 's3cret' })
  const res = await fetch(`http://127.0.0.1:${gw.port()}/__gw/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  await gw.close(); await up.close()
})

test('upgrade is forwarded with a rewritten Host', async () => {
  const up = await startUpstream((_req, res) => res.end())
  const gw = await gatewayFor(up.port)

  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(gw.port(), '127.0.0.1', () => {
      socket.write(
        'GET /api/ws HTTP/1.1\r\n' +
        'Host: dsh.example.com\r\n' +
        'Origin: https://dsh.example.com\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (buffer.includes('\r\n\r\n')) { socket.destroy(); resolve(buffer) }
    })
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); resolve(buffer) }, 3000)
  })

  assert.match(reply, /^HTTP\/1\.1 101/)
  assert.match(reply, new RegExp(`x-upstream-host: 127\\.0\\.0\\.1:${up.port}`))

  await gw.close(); await up.close()
})

test('upgrade is refused without the cookie when a token is set', async () => {
  const up = await startUpstream((_req, res) => res.end())
  const gw = await gatewayFor(up.port, { token: 's3cret' })

  const reply = await new Promise((resolve) => {
    const socket = net.connect(gw.port(), '127.0.0.1', () => {
      socket.write('GET /api/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    let buffer = ''
    socket.on('data', (chunk) => { buffer += chunk.toString('latin1') })
    socket.on('close', () => resolve(buffer))
    setTimeout(() => { socket.destroy(); resolve(buffer) }, 2000)
  })
  assert.match(reply, /^HTTP\/1\.1 401/)

  await gw.close(); await up.close()
})

test('a 401 document navigation is redirected to the launch URL', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(401).end('dsh web authentication required') })
  const gw = await gatewayFor(up.port, { getLaunchPath: () => '/?token=abc123' })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?token=abc123')

  await gw.close(); await up.close()
})

test('api calls are not redirected on 401', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(401).end('nope') })
  const gw = await gatewayFor(up.port, { getLaunchPath: () => '/?token=abc123' })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/api/x`, { headers: { accept: 'application/json' }, redirect: 'manual' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('location'), null)

  await gw.close(); await up.close()
})

test('injects the PWA head into index.html only', async () => {
  const up = await startUpstream((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>DSH</title></head><body>app</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const gw = await gatewayFor(up.port)

  const indexRes = await fetch(`http://127.0.0.1:${gw.port()}/`)
  const html = await indexRes.text()
  assert.match(html, /apple-mobile-web-app-capable/)
  assert.match(html, /\/__gw\/manifest\.webmanifest/)
  assert.equal(Number(indexRes.headers.get('content-length')), Buffer.byteLength(html))

  const json = await (await fetch(`http://127.0.0.1:${gw.port()}/api/x`)).text()
  assert.equal(json, '{"ok":true}')

  await gw.close(); await up.close()
})

test('decompresses a gzipped index before injecting', async () => {
  const page = '<!doctype html><html><head><title>DSH</title></head><body>app</body></html>'
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
    res.end(zlib.gzipSync(page))
  })
  const gw = await gatewayFor(up.port)

  const res = await fetch(`http://127.0.0.1:${gw.port()}/`)
  const html = await res.text()
  assert.equal(res.headers.get('content-encoding'), null)
  assert.match(html, /\/__gw\/manifest\.webmanifest/)
  assert.match(html, /<body>app<\/body>/)

  await gw.close(); await up.close()
})

test('mints the harness session itself when the phone has no cookie', async () => {
  const up = await startUpstream((req, res) => {
    if (req.headers.cookie === 'dsh-auth-x=1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head></head><body>ok</body></html>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' }).end('auth required')
  })
  const gw = await gatewayFor(up.port, { ensureSession: async () => 'dsh-auth-x=1' })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<body>ok<\/body>/)

  await gw.close(); await up.close()
})

test('replaces a stale browser cookie after a 401 and retries once', async () => {
  const seen = []
  const up = await startUpstream((req, res) => {
    seen.push(req.headers.cookie)
    if (req.headers.cookie === 'dsh-auth-x=1') { res.writeHead(200).end('ok'); return }
    res.writeHead(401).end('nope')
  })
  const gw = await gatewayFor(up.port, { ensureSession: async () => 'dsh-auth-x=1' })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/api/x`, {
    headers: { cookie: 'dsh-auth-x=stale', accept: 'application/json' },
    redirect: 'manual',
  })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'ok')
  assert.deepEqual(seen, ['dsh-auth-x=stale', 'dsh-auth-x=1'])

  await gw.close(); await up.close()
})

test('answers 204 for blocked path prefixes', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('big()') })
  const gw = await gatewayFor(up.port, { blockPaths: ['/dsh-whale/'] })

  const blocked = await fetch(`http://127.0.0.1:${gw.port()}/dsh-whale/widget.js`)
  assert.equal(blocked.status, 204)
  const kept = await fetch(`http://127.0.0.1:${gw.port()}/assets/index.js`)
  assert.equal(kept.status, 200)

  await gw.close(); await up.close()
})

test('trims the boot roster and keeps inject dependencies', async () => {
  const boot = { entries: [{ id: 'a', inject: ['b'] }, { id: 'b' }, { id: 'c' }] }
  const page = `<html><head></head><body><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(boot)}</script></body></html>`
  const up = await startUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page) })
  const gw = await gatewayFor(up.port, { dropClientPlugins: ['c'] })

  const out = await (await fetch(`http://127.0.0.1:${gw.port()}/`)).text()
  assert.match(out, /"id":"a"/)
  assert.match(out, /"id":"b"/)
  assert.doesNotMatch(out, /"id":"c"/)

  await gw.close(); await up.close()
})

const stubMobile = (overrides = {}) => ({
  list: async () => ({ workspaces: [] }),
  read: async (id) => ({ id, messages: [], approvals: [] }),
  prompt: async () => ({ accepted: true }),
  create: async () => ({ sessionId: 'session-new' }),
  cancel: async () => ({ accepted: true }),
  resolve: async () => ({ ok: true }),
  ...overrides,
})

const loginCookie = async (base) => {
  const res = await fetch(`${base}/__gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=s3cret',
    redirect: 'manual',
  })
  return res.headers.get('set-cookie').split(';')[0]
}

test('mobile routes require the password and delegate to the adapter', async () => {
  const up = await startUpstream((_req, res) => res.end('app'))
  const calls = []
  const gw = await gatewayFor(up.port, {
    token: 's3cret',
    mobile: stubMobile({
      list: async () => { calls.push('list'); return { workspaces: [] } },
      prompt: async (id, text) => { calls.push('prompt:' + id + ':' + text); return { accepted: true } },
      create: async (cwd) => { calls.push('create:' + cwd); return { sessionId: 'session-new' } },
      cancel: async (id) => { calls.push('cancel:' + id); return { accepted: true } },
    }),
  })
  const base = `http://127.0.0.1:${gw.port()}`

  const anonymous = await fetch(`${base}/m/api/sessions`, { redirect: 'manual' })
  assert.equal(anonymous.status, 401)

  const cookie = await loginCookie(base)
  const headers = { cookie, 'content-type': 'application/json' }

  assert.deepEqual(await (await fetch(`${base}/m/api/sessions`, { headers: { cookie } })).json(), { workspaces: [] })
  assert.deepEqual(
    await (await fetch(`${base}/m/api/prompt`, { method: 'POST', headers, body: JSON.stringify({ id: 's1', text: 'hi' }) })).json(),
    { accepted: true },
  )
  assert.deepEqual(
    await (await fetch(`${base}/m/api/create`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/tmp/x' }) })).json(),
    { sessionId: 'session-new' },
  )
  assert.deepEqual(
    await (await fetch(`${base}/m/api/cancel`, { method: 'POST', headers, body: JSON.stringify({ id: 's1' }) })).json(),
    { accepted: true },
  )
  assert.deepEqual(calls, ['list', 'prompt:s1:hi', 'create:/tmp/x', 'cancel:s1'])

  await gw.close(); await up.close()
})

test('mobile api is unavailable without an adapter', async () => {
  const up = await startUpstream((_req, res) => res.end('app'))
  const gw = await gatewayFor(up.port, { token: 's3cret' })
  const cookie = await loginCookie(`http://127.0.0.1:${gw.port()}`)
  const res = await fetch(`http://127.0.0.1:${gw.port()}/m/api/sessions`, { headers: { cookie } })
  assert.equal(res.status, 503)
  await gw.close(); await up.close()
})

test('the live event stream opens when an opener is provided', async () => {
  const up = await startUpstream((_req, res) => res.end('app'))
  let opened = null
  const gw = await gatewayFor(up.port, {
    openStream: (req, res, sessionId) => {
      opened = sessionId
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(': connected\n\n')
    },
  })
  const res = await fetch(`http://127.0.0.1:${gw.port()}/m/api/events?session=abc`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  assert.match(await res.text(), /: connected/)
  assert.equal(opened, 'abc')
  await gw.close(); await up.close()
})

test('refuses a non-loopback listener without a token', () => {
  assert.throws(
    () => createGateway({ listenHost: '0.0.0.0', listenPort: 0 }),
    /refusing to listen on 0\.0\.0\.0 without a token/,
  )
  assert.doesNotThrow(() => createGateway({ listenHost: '0.0.0.0', listenPort: 0, token: 'x' }))
  assert.doesNotThrow(() => createGateway({ listenHost: '0.0.0.0', listenPort: 0, allowInsecure: true }))
})

test('returns 503 when the upstream port is not known yet', async () => {
  const gw = createGateway({ listenPort: 0, getUpstream: () => ({ host: '127.0.0.1', port: 0 }) })
  await gw.listen()
  const res = await fetch(`http://127.0.0.1:${gw.port()}/`)
  assert.equal(res.status, 503)
  await gw.close()
})

/* ── crash regressions ───────────────────────────────────────────────────── */
// A throw escaping the http server callback is an uncaught exception, and dsh
// treats uncaught exceptions as fatal: the host exits 1 and the desktop app
// shows a crash. The request handler used to read `ctx.mobile`, but the handler
// is not lexically inside apply() — so EVERY proxied request killed the host.

const mobileStub = () => {
  const calls = []
  return {
    calls,
    async list() {
      calls.push('list')
      return { sessions: [{ id: 's1', title: 'hello' }] }
    },
    async read(id) {
      calls.push(`read:${id}`)
      return { id, title: 'hello', messages: [{ role: 'user', text: 'hi' }] }
    },
  }
}

test('a plain proxied request does not reference an out-of-scope ctx', async () => {
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream ok')
  })
  const gw = await gatewayFor(up.port, { mobile: mobileStub() })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'upstream ok')

  await gw.close(); await up.close()
})

test('serves the mobile API from the injected adapter', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200); res.end('x') })
  const mobile = mobileStub()
  const gw = await gatewayFor(up.port, { mobile })

  const list = await (await fetch(`http://127.0.0.1:${gw.port()}/m/api/sessions`)).json()
  assert.deepEqual(list, { sessions: [{ id: 's1', title: 'hello' }] })

  const one = await (await fetch(`http://127.0.0.1:${gw.port()}/m/api/session?id=s1`)).json()
  assert.equal(one.id, 's1')
  assert.deepEqual(one.messages, [{ role: 'user', text: 'hi' }])
  assert.deepEqual(mobile.calls, ['list', 'read:s1'])

  await gw.close(); await up.close()
})

test('mobile API answers 503 when no adapter is mounted', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200); res.end('x') })
  const gw = await gatewayFor(up.port)

  const res = await fetch(`http://127.0.0.1:${gw.port()}/m/api/sessions`)
  assert.equal(res.status, 503)

  await gw.close(); await up.close()
})

test('a throwing request handler answers 500 and leaves the server alive', async () => {
  const up = await startUpstream((_req, res) => { res.writeHead(200); res.end('x') })
  // blockPaths must be an array; a string makes blockPaths.some throw
  // synchronously inside the request callback.
  const gw = await gatewayFor(up.port, { blockPaths: '/not-an-array' })

  const res = await fetch(`http://127.0.0.1:${gw.port()}/`)
  assert.equal(res.status, 500)
  assert.match(await res.text(), /internal error/)

  // The listener is still up and serving.
  assert.equal((await fetch(`http://127.0.0.1:${gw.port()}/__gw/health`)).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${gw.port()}/`)).status, 500)

  await gw.close(); await up.close()
})
