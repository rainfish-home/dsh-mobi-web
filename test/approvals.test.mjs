import test from 'node:test'
import assert from 'node:assert/strict'
import { pendingApprovalsFromEvents } from '../lib/index.js'

const asked = (id, toolName = 'bash', reason = 'needs approval', time = 1000) => ({
  type: 'approval/asked',
  time,
  data: { id, toolName, reason, callId: 'call-' + id },
})
const decided = (id) => ({ type: 'approval/decided', time: 2000, data: { id, outcome: 'allowed-once' } })

test('an asked approval without a decision is pending', () => {
  const pending = pendingApprovalsFromEvents([asked('a1')])
  assert.deepEqual(pending, [{ id: 'a1', toolName: 'bash', reason: 'needs approval', at: 1000 }])
})

test('a decided approval is removed', () => {
  assert.deepEqual(pendingApprovalsFromEvents([asked('a1'), decided('a1')]), [])
})

test('deciding one of several leaves the others pending', () => {
  const pending = pendingApprovalsFromEvents([asked('a1'), asked('a2'), decided('a1')])
  assert.deepEqual(pending.map((one) => one.id), ['a2'])
})

test('approvals owned by the gateway are filtered out', () => {
  const pending = pendingApprovalsFromEvents(
    [asked('a1'), asked('a2')],
    (id) => id === 'a1',
  )
  assert.deepEqual(pending.map((one) => one.id), ['a2'])
})

test('the first ask is kept and the default tool name is used', () => {
  const first = { type: 'approval/asked', time: 10, data: { id: 'a1' } }
  const second = { type: 'approval/asked', time: 20, data: { id: 'a1', toolName: 'later' } }
  assert.deepEqual(pendingApprovalsFromEvents([first, second]), [
    { id: 'a1', toolName: 'tool', reason: undefined, at: 10 },
  ])
})

test('events without an id and malformed values are ignored', () => {
  const pending = pendingApprovalsFromEvents([
    null,
    { type: 'approval/asked' },
    { type: 'approval/asked', data: { id: '' } },
    { type: 'approval/decided', data: {} },
    asked('a1'),
  ])
  assert.deepEqual(pending.map((one) => one.id), ['a1'])
})

test('an empty or missing surface yields no pending approvals', () => {
  assert.deepEqual(pendingApprovalsFromEvents([]), [])
  assert.deepEqual(pendingApprovalsFromEvents(undefined), [])
})
