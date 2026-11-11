import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { apply, createPromptAdmission } from '../lib/index.js'

const controllerFor = (prompt) => ({ prompt })

test('a queued prompt is accepted from admission alone, without polling the surface', async () => {
  // Regression: the gateway used to wait 3.6 s for a `user/message` event and
  // reject the prompt if it did not appear. A prompt sent while a turn is
  // running lives in inbox.nextTurn until that turn ends, so the wait rejected
  // a message that was already queued — and each retry queued another copy.
  let captured
  const admit = createPromptAdmission({
    getController: () => controllerFor(async (request) => {
      captured = request
      return { accepted: true }
    }),
  })

  const admitted = await admit('session-1', '  m4，点击做。m3按你的建议  ', [], 'retry-key-1')
  assert.deepEqual(admitted.result, { accepted: true })
  assert.equal(admitted.requestId, 'm-retry-key-1')
  assert.equal(captured.sessionId, 'session-1')
  assert.equal(captured.mode, 'queue')
  assert.deepEqual(captured.content, [{ type: 'text', text: 'm4，点击做。m3按你的建议' }])
  assert.equal(typeof captured.requestId, 'string')
})

test('the client retry key is stable, so a retry is not queued twice', async () => {
  const seen = []
  const admit = createPromptAdmission({
    getController: () => controllerFor(async (request) => {
      seen.push(request.requestId)
      return { accepted: true }
    }),
  })
  await admit('session-1', 'same text', [], 'abcdef123456')
  await admit('session-1', 'same text', [], 'abcdef123456')
  assert.deepEqual(seen, ['m-abcdef123456', 'm-abcdef123456'])
})

test('an absent or malformed retry key is replaced by a fresh one', async () => {
  const seen = []
  const admit = createPromptAdmission({
    getController: () => controllerFor(async (request) => {
      seen.push(request.requestId)
      return { accepted: true }
    }),
  })
  await admit('session-1', 'one')
  await admit('session-1', 'two', [], 'bad key with spaces')
  assert.match(seen[0], /^m-[0-9a-f-]{36}$/)
  assert.match(seen[1], /^m-[0-9a-f-]{36}$/)
  assert.notEqual(seen[0], seen[1])
})

test('the admission callback sees the request before the controller does', async () => {
  const order = []
  const admit = createPromptAdmission({
    getController: () => controllerFor(async () => {
      order.push('prompt')
      return { accepted: true }
    }),
    onRequest: (sessionId, rpcId) => order.push(`track:${sessionId}:${rpcId}`),
  })
  await admit('session-1', 'hi', [], '12345678')
  assert.deepEqual(order, ['track:session-1:m-12345678', 'prompt'])
})

test('a controller failure is surfaced instead of being reported as accepted', async () => {
  const admit = createPromptAdmission({
    getController: () => controllerFor(async () => {
      throw new Error('gateway/internal: prompt rejected')
    }),
  })
  await assert.rejects(() => admit('session-1', 'hi'), /prompt rejected/)
})

test('an explicit rejection is a user-facing failure', async () => {
  const admit = createPromptAdmission({
    getController: () => controllerFor(async () => ({ accepted: false })),
  })
  await assert.rejects(() => admit('session-1', 'hi'), (error) => {
    assert.equal(error.userMessage, '消息没有进入会话，请重试')
    return true
  })
})

test('empty text and invalid images are rejected before admission', async () => {
  let called = false
  const admit = createPromptAdmission({
    getController: () => controllerFor(async () => {
      called = true
      return { accepted: true }
    }),
  })
  await assert.rejects(() => admit('session-1', '   ', [{ mediaType: 'text/plain', data: 'x' }]), /消息不能为空/)
  assert.equal(called, false)
})

test('images are bounded and invalid image parts are dropped', async () => {
  let captured
  const admit = createPromptAdmission({
    getController: () => controllerFor(async (request) => {
      captured = request
      return { accepted: true }
    }),
  })
  const images = Array.from({ length: 6 }, (_, index) => ({
    mediaType: 'image/png',
    data: `data-${index}`,
    name: `p${index}.png`,
  }))
  images.push({ mediaType: 'text/plain', data: 'nope' })
  images.push({ mediaType: 'image/png', data: '' })
  await admit('session-1', '', images)
  assert.deepEqual(captured.content.map((part) => part.data), ['data-0', 'data-1', 'data-2', 'data-3'])
})

test('the controller being unavailable is an internal failure, not a user message', async () => {
  const admit = createPromptAdmission({ getController: () => undefined })
  await assert.rejects(() => admit('session-1', 'hi'), /sessionController unavailable/)
})

test('a missing session id is rejected before the controller is called', async () => {
  let called = false
  const admit = createPromptAdmission({
    getController: () => controllerFor(async () => {
      called = true
      return { accepted: true }
    }),
  })
  await assert.rejects(() => admit('', 'hi'), /缺少会话标识/)
  assert.equal(called, false)
})

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})

const waitForHealth = async (port) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__gw/health`)
      if (res.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('gateway did not start')
}

test('apply() admits a prompt through the mounted gateway (no transcript polling)', async () => {
  // This covers the wiring that unit tests alone missed: admitPrompt is created
  // after the retry tracker it closes over, and the /m/api/prompt route must
  // forward the client request id. A TDZ mistake here breaks every send.
  const port = await freePort()
  let captured
  let cleanup
  const controller = {
    prompt: async (request) => {
      captured = request
      return { accepted: true }
    },
  }
  const ctx = {
    webServer: { port: 1 },
    logger: undefined,
    get: (name) => (name === 'sessionController' ? controller : undefined),
    on: () => {},
    effect: (fn) => { cleanup = fn() },
  }
  apply(ctx, { token: false, listenHost: '127.0.0.1', listenPort: port })
  await waitForHealth(port)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/m/api/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'session-1', text: 'queued while busy', requestId: 'abcdef123456' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { accepted: true })
    assert.equal(captured.sessionId, 'session-1')
    assert.equal(captured.requestId, 'm-abcdef123456')
    assert.equal(captured.mode, 'queue')
  } finally {
    await cleanup?.()
  }
})

test('create() joins the workspace that owns the directory', async () => {
  // Regression: the phone's "+" sent only cwd, sessionController.create was
  // called without workspaceId, and the session showed up under "Ungrouped"
  // on the desktop even though its cwd was a registered workspace.
  const port = await freePort()
  const requests = []
  let cleanup
  const controller = {
    create: async (request) => {
      requests.push(request)
      return { sessionId: 'session-new' }
    },
  }
  const registry = {
    resolveByPath: async (path) => (path === '/tmp/registered' ? { id: 'workspace-1' } : undefined),
  }
  const ctx = {
    webServer: { port: 1 },
    logger: undefined,
    get: (name) => (name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined),
    on: () => {},
    effect: (fn) => { cleanup = fn() },
  }
  apply(ctx, { token: false, listenHost: '127.0.0.1', listenPort: port })
  await waitForHealth(port)
  try {
    const post = (cwd) => fetch(`http://127.0.0.1:${port}/m/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    const joined = await post('/tmp/registered')
    assert.equal(joined.status, 200)
    assert.deepEqual(await joined.json(), { sessionId: 'session-new' })
    const loose = await post('/tmp/loose')
    assert.equal(loose.status, 200)
    assert.deepEqual(requests, [{ workspaceId: 'workspace-1' }, { cwd: '/tmp/loose' }])
  } finally {
    await cleanup?.()
  }
})

test('list() hides blank Sessions like the desktop', async () => {
  const port = await freePort()
  let cleanup
  const controller = {
    list: async () => ({ items: [
      { sessionId: 's1', cwd: '/w', updatedAt: 1, running: false, blank: true, agentAvailable: false },
      { sessionId: 's2', cwd: '/w', updatedAt: 2, running: false, blank: false, agentAvailable: false },
    ] }),
  }
  const query = {
    listSessions: async () => [
      { header: { id: 's1', cwd: '/w', createdAt: 1 } },
      { header: { id: 's2', cwd: '/w', createdAt: 2 } },
    ],
    readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, title: id === 's1' ? 'blank' : 'real' })),
  }
  const registry = {
    list: () => [{ id: 'w1', title: 'W', path: '/w', sessionIds: ['s1', 's2'] }],
    archivedSessionIds: [],
  }
  const ctx = {
    webServer: { port: 1 },
    logger: undefined,
    get: (name) => (name === 'sessionController' ? controller : name === 'sessionQuery' ? query : name === 'workspaceRegistry' ? registry : undefined),
    on: () => {},
    effect: (fn) => { cleanup = fn() },
  }
  apply(ctx, { token: false, listenHost: '127.0.0.1', listenPort: port })
  await waitForHealth(port)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/m/api/sessions`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(data.workspaces.map((workspace) => workspace.sessions.map((session) => session.id)), [['s2']])
    assert.equal(data.workspaces[0].sessions[0].title, 'real')
    assert.equal(data.workspaces[0].sessions[0].blank, false)
  } finally {
    await cleanup?.()
  }
})
