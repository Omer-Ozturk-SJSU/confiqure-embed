// #160 SDK regression — frontend-tool NACK + reconnect dedupe.
//
// Runs against the BUILT output (`dist/`, produced by the `pretest` tsc step). Zero test deps:
// Node's built-in test runner + a minimal `window` stub that captures the message listener the
// EventBus registers, so we can fire synthetic `confiqure:tool` messages at it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../dist/events.js'

const ORIGIN = 'https://host.example'

/** Wire up an EventBus with a stub window; return helpers to fire messages and read replies. */
function harness() {
  let listener = null
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => {}
  }
  const bus = new EventBus(ORIGIN)
  bus.startListening()
  const posted = []
  const post = (msg) => posted.push(msg)
  const fire = (data) => listener({ origin: ORIGIN, data })
  const results = () => posted.filter((m) => m.type === 'confiqure:tool-result')
  return { bus, fire, posted, post, results }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('unhandled tool name → immediate error result (no 5-minute hang)', () => {
  const h = harness()
  h.bus.configureTools({}, h.post) // no handlers registered

  h.fire({ type: 'confiqure:tool', toolName: 'item_disposition_picker', sessionId: 7, input: {} })

  assert.equal(h.results().length, 1, 'exactly one tool-result posted synchronously')
  const r = h.results()[0]
  assert.equal(r.sessionId, 7)
  assert.match(r.error, /no handler registered/i)
  assert.equal(r.result, undefined, 'a NACK carries an error, not a result')
})

test('duplicate sessionId while in-flight → handler runs once (single popup)', async () => {
  const h = harness()
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  h.bus.configureTools({
    item_disposition_picker: async () => { calls++; await gate; return { disposition: 'RESTOCK' } }
  }, h.post)

  const evt = { type: 'confiqure:tool', toolName: 'item_disposition_picker', sessionId: 9, input: {} }
  h.fire(evt)        // original dispatch
  h.fire({ ...evt }) // reconnect replay — same sessionId

  await tick()
  assert.equal(calls, 1, 'handler invoked once despite the duplicate dispatch')

  release()
  await tick()
  assert.equal(h.results().length, 1, 'exactly one result reaches the backend')
  assert.deepEqual(h.results()[0].result, { disposition: 'RESTOCK' })
})

test('after the handler settles, a later same-sessionId dispatch runs again (reload semantics)', async () => {
  const h = harness()
  let calls = 0
  h.bus.configureTools({ t: async () => { calls++; return { ok: true } } }, h.post)

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 5, input: {} })
  await tick() // handler resolves and cleanup clears the in-flight id
  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 5, input: {} })
  await tick()

  assert.equal(calls, 2, 'dedupe holds only WHILE in-flight, not forever')
})

test('distinct sessionIds are never deduped against each other', async () => {
  const h = harness()
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  h.bus.configureTools({ t: async () => { calls++; await gate; return { ok: true } } }, h.post)

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 1, input: {} })
  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 2, input: {} })
  await tick()
  assert.equal(calls, 2, 'two different sessions both run')
  release()
})
