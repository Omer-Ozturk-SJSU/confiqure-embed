// #321 SDK regression — destroy() must not drop an in-flight frontend-tool reply.
//
// The bug: the tool result is posted to the widget AFTER the handler promise resolves. A host
// tool whose SIDE EFFECT unmounts the embed (navigate, close the modal, lift an onboarding
// lockdown) therefore races its own reply — `iframe.contentWindow?.postMessage(...)` no-oped
// silently and the platform held the tool session for its full 5-minute window (TIMED_OUT).
//
// The fix has three halves, all exercised here: destroy() defers teardown (bounded) until every
// handler has replied and every reply is ACKed by the widget; an undeliverable post is a loud
// console.error instead of a silent no-op; and a widget too old to ACK falls back to a grace
// timeout so a new SDK against an old widget still tears down promptly.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { init } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'

function makeToken(claims = { workspaceKey: 'wkey12', configEnd: 'restock' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

/**
 * Stub window + document so init() runs its REAL path. Returns:
 *  - target: the mount container for init({ target })
 *  - fire(data): deliver a synthetic postMessage from the widget to the SDK's listener
 *  - posted: every message the SDK postMessaged into the iframe
 *  - results(): just the confiqure:tool-result messages
 *  - iframe: the stub iframe (`removed` flips true when the SDK tears it down)
 *  - killIframe(): simulate the host ripping the iframe out from under the SDK
 */
function harness() {
  let listener = null
  const posted = []
  const iframe = {
    src: '',
    style: {},
    isConnected: true,
    removed: false,
    setAttribute() {},
    remove() { this.removed = true; this.isConnected = false; this.contentWindow = null },
    contentWindow: { postMessage: (msg) => posted.push(msg) }
  }
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => { listener = null }
  }
  globalThis.document = { createElement: () => iframe, querySelector: () => null }
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })

  return {
    target: { appendChild() {} },
    iframe,
    posted,
    fire: (data) => listener?.({ origin: ORIGIN, data }),
    results: () => posted.filter((m) => m.type === 'confiqure:tool-result'),
    killIframe: () => { iframe.isConnected = false; iframe.contentWindow = null }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const after = (ms) => new Promise((r) => setTimeout(r, ms))

/** Capture console.error/warn for the duration of `fn`. */
async function capturingConsole(fn) {
  const errors = []
  const warns = []
  const realError = console.error
  const realWarn = console.warn
  console.error = (...a) => errors.push(a.map(String).join(' '))
  console.warn = (...a) => warns.push(a.map(String).join(' '))
  try { return { value: await fn(), errors, warns } }
  finally { console.error = realError; console.warn = realWarn }
}

async function mount(h, tools) {
  const chat = await init({ target: h.target, token: makeToken(), tools })
  h.fire({ type: 'confiqure:ready' })
  return chat
}

test('nothing in flight → destroy() tears down immediately (unchanged behavior)', async () => {
  const h = harness()
  const chat = await mount(h, {})
  chat.destroy()
  assert.equal(h.iframe.removed, true, 'teardown is synchronous when there is no tool work')
})

test('destroy() during a running handler defers teardown until the reply is posted AND acked', async () => {
  const h = harness()
  let release
  const gate = new Promise((r) => { release = r })
  // The live shape: the handler's own side effect unmounts the widget, then it resolves.
  const chat = await mount(h, { onboarding_complete: async () => { await gate; return { ok: true } } })

  h.fire({ type: 'confiqure:tool', toolName: 'onboarding_complete', sessionId: 42, input: {} })
  await tick()

  chat.destroy()
  await tick()
  assert.equal(h.iframe.removed, false, 'teardown is deferred while the handler is still running')

  release()
  await tick()
  assert.equal(h.results().length, 1, 'the reply was posted into the still-live iframe')
  assert.deepEqual(h.results()[0], { type: 'confiqure:tool-result', sessionId: 42, result: { ok: true } })
  assert.equal(h.iframe.removed, false, 'still deferred: the widget has not acked delivery yet')

  h.fire({ type: 'confiqure:tool-result-ack', sessionId: 42, ok: true })
  await tick()
  assert.equal(h.iframe.removed, true, 'the ack releases the flush and teardown completes')
})

test('destroy() right after a reply is posted waits for that reply\'s ack', async () => {
  const h = harness()
  const chat = await mount(h, { t: async () => ({ ok: true }) })

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 7, input: {} })
  await tick()
  assert.equal(h.results().length, 1, 'the handler already replied')

  chat.destroy()
  await tick()
  assert.equal(h.iframe.removed, false, 'a posted-but-unacked reply still holds teardown')

  h.fire({ type: 'confiqure:tool-result-ack', sessionId: 7, ok: true })
  await tick()
  assert.equal(h.iframe.removed, true)
})

test('old widget (never acks) → destroy() falls back to the grace timeout and warns once', async () => {
  const h = harness()
  const chat = await mount(h, { t: async () => ({ ok: true }) })

  const { errors, warns } = await capturingConsole(async () => {
    h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 3, input: {} })
    await tick()
    chat.destroy()
    // No confiqure:tool-result-ack ever arrives — the pre-#321 widget does not send one.
    await after(1400) // > ACK_GRACE_MS (1000), < FLUSH_CAP_MS (2000)
  })

  assert.equal(h.iframe.removed, true, 'teardown completes on the grace timeout, well inside the cap')
  assert.equal(errors.length, 0, 'an un-acked (not dropped) reply is a warning, never an error')
  assert.equal(warns.length, 1, 'exactly one warning — not one per tool call')
  assert.match(warns[0], /never confirmed receipt/i)
})

test('a normal tool call against an old widget does NOT warn (no ack-timeout spam)', async () => {
  const h = harness()
  const chat = await mount(h, { t: async () => ({ ok: true }) })

  const { errors, warns } = await capturingConsole(async () => {
    h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 11, input: {} })
    await after(1400) // the grace expires with nobody destroying — must be silent
  })

  assert.deepEqual(warns, [], 'the ack grace only reports when destroy() was actually waiting')
  assert.deepEqual(errors, [])
  chat.destroy()
})

test('a reply posted into a dead iframe is a loud console.error, never a silent drop', async () => {
  const h = harness()
  let release
  const gate = new Promise((r) => { release = r })
  await mount(h, { t: async () => { await gate; return { ok: true } } })

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 5, input: {} })
  await tick()

  const { errors } = await capturingConsole(async () => {
    h.killIframe() // the host removed the container itself — no destroy() call to defer
    release()
    await tick()
  })

  assert.equal(h.results().length, 0, 'nothing could be delivered')
  assert.equal(errors.length, 1, 'the dropped result is reported')
  assert.match(errors[0], /no longer on the page/i)
  assert.match(errors[0], /tool session expires/i)
})

test('a wedged handler cannot hold teardown past the cap; the drop is reported', async () => {
  const h = harness()
  const chat = await mount(h, { t: async () => new Promise(() => {}) }) // never settles

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 8, input: {} })
  await tick()

  const started = Date.now()
  const { errors } = await capturingConsole(async () => {
    chat.destroy()
    await after(2400) // > FLUSH_CAP_MS (2000)
  })
  const elapsed = Date.now() - started

  assert.equal(h.iframe.removed, true, 'teardown happens regardless — the flush is hard-capped')
  assert.ok(elapsed >= 2000, `waited the cap before giving up (was ${elapsed}ms)`)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /never reached confiqure/i)
})

test('a tool call arriving mid-flush is NACKed, not run (no new 5-minute hold)', async () => {
  const h = harness()
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const chat = await mount(h, {
    slow: async () => { await gate; return { ok: true } },
    late: async () => { calls++; return { ok: true } }
  })

  h.fire({ type: 'confiqure:tool', toolName: 'slow', sessionId: 1, input: {} })
  await tick()
  chat.destroy() // starts the drain

  await capturingConsole(async () => {
    h.fire({ type: 'confiqure:tool', toolName: 'late', sessionId: 2, input: {} })
    await tick()
  })

  assert.equal(calls, 0, 'no new handler runs once destroy() has started')
  const nack = h.results().find((m) => m.sessionId === 2)
  assert.ok(nack, 'the late call still gets a reply rather than parking the session')
  assert.match(nack.error, /destroyed before this tool could run/i)

  release()
  await tick() // let the slow handler's reply post (and register as unacked) before acking it
  h.fire({ type: 'confiqure:tool-result-ack', sessionId: 1, ok: true })
  h.fire({ type: 'confiqure:tool-result-ack', sessionId: 2, ok: true })
  await tick()
  assert.equal(h.iframe.removed, true, 'teardown completes once both replies are acked')
})

test('destroy() is idempotent — a second call during the flush does not double-tear-down', async () => {
  const h = harness()
  let release
  const gate = new Promise((r) => { release = r })
  const chat = await mount(h, { t: async () => { await gate; return { ok: true } } })

  h.fire({ type: 'confiqure:tool', toolName: 't', sessionId: 4, input: {} })
  await tick()
  chat.destroy()
  chat.destroy()
  await tick()
  assert.equal(h.iframe.removed, false)

  release()
  await tick()
  h.fire({ type: 'confiqure:tool-result-ack', sessionId: 4, ok: true })
  await tick()
  assert.equal(h.iframe.removed, true)
})
