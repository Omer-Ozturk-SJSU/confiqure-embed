// #243 SDK regression — the open() `data` hand-off is un-proxied, shape-validated, and its
// delivery can never hang chat.submission.
//
// The bug: a Vue reactive `ref`/`reactive` value is a JavaScript Proxy, and `postMessage` —
// the only path `data` takes into the chat iframe — runs structuredClone, which CANNOT clone a
// Proxy (it throws DataCloneError). The throw fired inside the submit-ready handler AFTER the
// hand-off was marked spent, so chat.submission hung forever and nothing reached confiqure.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps:
// Node's built-in test runner + minimal window/document stubs so open() runs its REAL path and
// we capture the payload it postMessages into the (fake) chat iframe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'

/** A token whose base64url payload carries the workspaceKey + configEnd claims open() decodes. */
function makeToken(claims = { workspaceKey: 'wkey12', configEnd: 'restock' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

/**
 * Stub window + document so open() reaches the submit-ready delivery. Returns:
 *  - target: the mount container to pass as open({ target })
 *  - fire(data): deliver a synthetic postMessage from the iframe to the SDK's message listener
 *  - submits(): the payloads the SDK postMessaged into the iframe with type confiqure:submit
 *  - setPostMessage(fn): override iframe.contentWindow.postMessage (to simulate a delivery throw)
 */
function harness() {
  let listener = null
  const submits = []
  let postMessage = (msg) => { if (msg && msg.type === 'confiqure:submit') submits.push(msg) }

  const iframe = {
    src: '',
    style: {},
    setAttribute() {},
    remove() {},
    contentWindow: { postMessage: (msg) => postMessage(msg) }
  }
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => {}
    // no sessionStorage → resolveTabId() returns undefined via its try/catch (legacy behavior)
  }
  globalThis.document = {
    createElement: () => iframe,
    querySelector: () => null
  }
  // frontend-tools discovery is best-effort and void'd; keep it from making a real network call.
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })

  const target = { appendChild() {} }
  return {
    target,
    fire: (data) => listener?.({ origin: ORIGIN, data }),
    submits: () => submits,
    setPostMessage: (fn) => { postMessage = fn }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('open(): a Proxy-wrapped data payload is delivered equal to the plain object', async () => {
  const h = harness()
  const plain = { restockList: [{ asin: 'B01', qty: 3 }, { asin: 'B02', qty: 7 }], note: 'from discovery' }
  // Simulate a framework reactive wrapper (Vue ref/reactive et al.) — a Proxy over the real DTO.
  const proxy = new Proxy(structuredClone(plain), {})
  // Premise (the #243 root cause): postMessage's structuredClone cannot clone the Proxy directly.
  assert.throws(() => structuredClone(proxy), 'a raw Proxy is NOT structured-clone-safe (the bug)')

  const chat = await open({ target: h.target, token: makeToken(), data: proxy })
  assert.equal(typeof chat.submission?.then, 'function', 'submission promise exists when data is handed off')

  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })
  await tick()

  const sent = h.submits()
  assert.equal(sent.length, 1, 'exactly one confiqure:submit posted to the iframe')
  assert.equal(sent[0].type, 'confiqure:submit')
  assert.deepEqual(sent[0].data, plain, 'delivered data equals the plain object')
  // The delivered message must survive structuredClone — postMessage runs it for real. This is the
  // fix's whole point: extractHandoff un-proxied the payload so delivery no longer throws.
  assert.doesNotThrow(() => structuredClone(sent[0]), 'delivered payload is structured-clone-safe')

  chat.destroy()
})

test('open(): array data rejects deterministically (never silently dropped)', async () => {
  const h = harness()
  await assert.rejects(
    open({ target: h.target, token: makeToken(), data: [{ asin: 'B01' }] }),
    /must be a plain object/i,
    'an array data payload rejects with a descriptive error'
  )
})

test('open(): string data rejects deterministically (never silently dropped)', async () => {
  const h = harness()
  await assert.rejects(
    open({ target: h.target, token: makeToken(), data: 'restockList' }),
    /must be a plain object/i,
    'a string data payload rejects with a descriptive error'
  )
})

test('open(): a delivery failure rejects chat.submission instead of hanging it', async () => {
  const h = harness()
  // Force the delivery postMessage to throw the way structuredClone would on a non-cloneable value.
  h.setPostMessage(() => { throw new DOMException('#<Object> could not be cloned.', 'DataCloneError') })

  const chat = await open({ target: h.target, token: makeToken(), data: { restockList: [{ asin: 'B01' }] } })
  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })

  await assert.rejects(chat.submission, /failed to deliver the open\(\) hand-off/i,
    'submission rejects with the real delivery error rather than hanging forever')

  chat.destroy()
})
