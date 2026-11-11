#!/usr/bin/env node
// Attach existing Sessions to the Workspace that owns their cwd.
//
// Why this exists: before dsh-mobi-web 0.1.2, the phone's "＋" called
// sessionController.create({cwd}) without a workspaceId. The Session was
// created with the right cwd, but it never joined a Workspace, so the desktop
// showed it under "Ungrouped" — while the phone's list hid the problem by
// grouping loose Sessions by cwd. 0.1.2 fixes new creates; this one-off repairs
// Sessions that already lost their membership.
//
// The app must be QUIT before writing: the running WorkspaceRegistry holds the
// same document in memory and would overwrite a file edited underneath it.
//
// Usage:
//   node scripts/attach-sessions.mjs --list
//   node scripts/attach-sessions.mjs --dry-run <session-id>...
//   node scripts/attach-sessions.mjs <session-id>...
//
// Ids are the `#session-…` part of a desktop or phone URL, or the first column
// of --list. --list only reads and can run while the app is open.

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE = join(DSH_HOME, 'storages', 'workspace.json')
const SESSIONS = join(DSH_HOME, 'sessions')

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const dryRun = args.includes('--dry-run')
const ids = args.filter((arg) => !arg.startsWith('--'))
const unknown = args.filter((arg) => arg.startsWith('--') && !['--list', '--dry-run', '--help', '-h'].includes(arg))
if (unknown.length > 0 || args.includes('--help') || args.includes('-h') || (!listOnly && ids.length === 0)) {
  console.log(`usage:
  node scripts/attach-sessions.mjs --list
  node scripts/attach-sessions.mjs --dry-run <session-id>...
  node scripts/attach-sessions.mjs <session-id>...

--list only reads and works while the app is open.
Writing requires the app to be quit (the WorkspaceRegistry would overwrite it).`)
  process.exit(unknown.length > 0 ? 2 : 0)
}

const fatal = (message) => {
  console.error('error: ' + message)
  process.exit(1)
}

const canonical = (path) => {
  try { return realpathSync(path) } catch { return path }
}

const alive = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__gw/health`, { signal: AbortSignal.timeout(600) })
    return res.ok
  } catch {
    return false
  }
}

const appRunning = () => {
  // The gateway port closes a few seconds BEFORE the app process exits (see
  // HANDOFF); writing then would race the host's own shutdown write.
  try {
    const name = process.env.DSH_APP_NAME || 'DeepSeek Harness'
    return execFileSync('osascript', ['-e', `application "${name}" is running`], { encoding: 'utf8' }).trim() === 'true'
  } catch {
    return false
  }
}

if (!listOnly && !dryRun) {
  if (appRunning()) fatal('DeepSeek Harness is still running. Quit it fully (wait for the process to exit), then rerun this command.')
  // The gateway is the app: if it answers, the registry owns the document.
  if (await alive(3083) || await alive(3183)) {
    fatal('the dsh-mobi-web gateway is still answering. Quit DeepSeek Harness first, then rerun this command.')
  }
}

if (typeof zstdDecompressSync !== 'function') {
  fatal('this script needs Node 22.15+ (zlib.zstdDecompressSync). Run it with the app\'s Node: /Applications/DeepSeek\\ Harness.app/Contents/Resources/runtime/bin/node')
}

let doc
try {
  doc = JSON.parse(readFileSync(STORE, 'utf8'))
} catch (error) {
  fatal(`cannot read ${STORE}: ${error.message}`)
}
const state = doc.global ?? {}
if (state.pendingMutation !== undefined) {
  fatal('the Workspace domain has a pending mutation. Start and quit the app once so it can recover, then rerun.')
}
const workspaces = doc.tables?.workspaces
if (workspaces === undefined) fatal('workspace.json has no workspaces table')

const byPath = new Map()
const accounted = new Map()
for (const [workspaceId, record] of Object.entries(workspaces)) {
  byPath.set(record.path, workspaceId)
  for (const sessionId of record.sessionIds) accounted.set(sessionId, workspaceId)
}

const logs = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else if (/^session\..+\.jsonl\.zstd$/.test(name)) logs.push(path)
  }
}
walk(SESSIONS)

// Session logs are concatenated Zstandard frames; Node's one-shot decoder
// reads only the first. The frame walk below is the same structural scan the
// host's persistence backend uses (dsh-session-persistence-jsonl/zstd).
const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const decodeSessionLog = (file) => {
  const buffer = readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('no complete Zstandard frame')
  if (tornStart !== undefined) console.warn(`warning: ${file} has a torn final frame; reading the complete prefix`)
  const chunks = frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)))
  return Buffer.concat(chunks).toString('utf8')
}

const readSession = (file) => {
  const raw = decodeSessionLog(file)
  let header
  let title
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') header = event
    else if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    else if (title === undefined && event.type === 'user/message') {
      const text = (event.data?.content ?? [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ')
        .trim()
      if (text !== '') title = text.slice(0, 48)
    }
  }
  return { header, title }
}

const sessions = []
for (const file of logs) {
  let session
  try { session = readSession(file) } catch (error) {
    console.warn(`warning: skip ${file}: ${error.message}`)
    continue
  }
  if (session.header?.id === undefined) continue
  sessions.push({ ...session, file })
}

if (listOnly) {
  const candidates = sessions
    .filter((session) => !accounted.has(session.header.id))
    .map((session) => ({ ...session, cwd: canonical(session.header.cwd), workspaceId: byPath.get(canonical(session.header.cwd)) }))
    .filter((session) => session.workspaceId !== undefined)
  if (candidates.length === 0) {
    console.log('no ungrouped Sessions match a registered Workspace')
    process.exit(0)
  }
  candidates.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
  for (const session of candidates) {
    const workspace = workspaces[session.workspaceId]
    console.log(`${session.header.id}  ->  ${workspace.title}\n    ${session.title ?? '(untitled)'}`)
  }
  console.log(`\n${candidates.length} candidate(s). Attach with: node scripts/attach-sessions.mjs ${candidates.map((session) => session.header.id).join(' ')}`)
  process.exit(0)
}

const byId = new Map(sessions.map((session) => [session.header.id, session]))
const changes = []
for (const id of ids) {
  if (accounted.has(id)) {
    console.log(`skip ${id}: already in workspace ${workspaces[accounted.get(id)].title}`)
    continue
  }
  const session = byId.get(id)
  if (session === undefined) {
    console.error(`skip ${id}: no session log found under ${SESSIONS}`)
    continue
  }
  const cwd = canonical(session.header.cwd)
  const workspaceId = byPath.get(cwd)
  if (workspaceId === undefined) {
    console.error(`skip ${id}: no registered workspace at ${cwd}`)
    continue
  }
  const record = workspaces[workspaceId]
  if (record.sessionIds.includes(id)) {
    console.log(`skip ${id}: already in ${record.title}`)
    continue
  }
  record.sessionIds.unshift(id)
  record.updatedAt = new Date().toISOString()
  accounted.set(id, workspaceId)
  changes.push({ id, title: session.title, workspace: record.title })
}

for (const change of changes) {
  console.log(`${dryRun ? 'would attach' : 'attach'} ${change.id} -> ${change.workspace}  ${change.title ?? ''}`)
}
if (changes.length === 0) {
  console.log('nothing to do')
  process.exit(0)
}
if (dryRun) {
  console.log('dry run: workspace.json not changed')
  process.exit(0)
}

// Validate the same invariant the registry checks on boot: one owner per id.
const seen = new Map()
for (const [workspaceId, record] of Object.entries(workspaces)) {
  for (const sessionId of record.sessionIds) {
    if (seen.has(sessionId)) fatal(`refusing to write: session ${sessionId} is in both ${seen.get(sessionId)} and ${workspaceId}`)
    seen.set(sessionId, workspaceId)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${STORE}.bak-${stamp}`
copyFileSync(STORE, backup)
const temporary = `${STORE}.tmp-${process.pid}`
writeFileSync(temporary, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
renameSync(temporary, STORE)
console.log(`\nbackup: ${backup}`)
console.log(`updated: ${STORE}`)
console.log('Start DeepSeek Harness again; the Sessions should be under their Workspaces.')
