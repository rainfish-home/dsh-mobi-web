import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `DSH_HOME` is captured when the module is evaluated, so each case has to take
// a fresh instance: a unique query string gives a distinct ESM cache entry.
const loadFresh = async (home) => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?home=${encodeURIComponent(home)}`)
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  return mod
}

test('token bootstrap: minted once, then read back from $DSH_HOME', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mobi-web-token-'))
  try {
    const { resolveToken } = await loadFresh(home)

    const minted = resolveToken(undefined)
    assert.equal(minted.source, 'minted')
    assert.equal(minted.saved, true)
    assert.match(minted.token, /^[0-9a-f]{32}$/)

    const file = join(home, 'dsh-mobi-web-token')
    assert.equal(minted.file, file)
    assert.equal(readFileSync(file, 'utf8').trim(), minted.token)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the token file must not be group/world readable')

    const again = resolveToken(undefined)
    assert.equal(again.source, 'file')
    assert.equal(again.token, minted.token, 'a restart must not rotate the password')
    assert.equal(again.file, file)

    const configured = resolveToken('explicit-token')
    assert.deepEqual({ token: configured.token, source: configured.source }, { token: 'explicit-token', source: 'config' })

    const disabled = resolveToken(false)
    assert.deepEqual({ token: disabled.token, source: disabled.source }, { token: '', source: 'disabled' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('token bootstrap: an unwritable home still yields a usable token, flagged as unsaved', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mobi-web-readonly-'))
  try {
    // A *file* where the home directory should be: mkdir and write both fail.
    const blocked = join(home, 'not-a-directory')
    writeFileSync(blocked, '')
    const { resolveToken } = await loadFresh(blocked)

    const minted = resolveToken(undefined)
    assert.equal(minted.source, 'minted')
    assert.equal(minted.saved, false, 'the caller has to know the token exists only in memory')
    assert.match(minted.token, /^[0-9a-f]{32}$/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
