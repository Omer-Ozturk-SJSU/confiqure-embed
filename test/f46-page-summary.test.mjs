// F46 (the Founder, rows 10770 / 10775): open({ pageSummary, toolClasses }) — normalized like data (#243), carried in the
// hand-off, never merged into data, counted as context; synthetic page / class names only.
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

test('open(): a page summary and a tool-class list ride the hand-off, apart from data', async () => {
  const h = harness()
  const board = { cards: 3, overdue: ['A-1'] }
  const chat = await open({
    target: h.target, token: makeToken(),
    pageSummary: { page: 'demo-board', asOf: '2026-10-07T15:00:00Z', data: new Proxy(structuredClone(board), {}) },
    toolClasses: [' DemoTool ', 'OtherDemoTool']
  })
  assert.equal(typeof chat.submission?.then, 'function', 'a summary-only open is a hand-off')
  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })
  await tick()
  const sent = h.submits()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].pageSummary, { page: 'demo-board', asOf: '2026-10-07T15:00:00Z', data: board })
  assert.deepEqual(sent[0].toolClasses, ['DemoTool', 'OtherDemoTool'], 'trimmed, order kept: the first is current')
  assert.equal(sent[0].data, undefined, 'never merged into data')
  assert.doesNotThrow(() => structuredClone(sent[0]), 'structured-clone-safe')
  chat.destroy()
})

test('open(): six tool classes, or a summary without page / asOf, reject in the host console', async () => {
  const h = harness()
  await assert.rejects(open({ target: h.target, token: makeToken(), toolClasses: ['A', 'B', 'C', 'D', 'E', 'F'] }), /at most 5/)
  await assert.rejects(open({ target: h.target, token: makeToken(), pageSummary: { data: {} } }), /page and asOf as strings/)
  await assert.rejects(open({ target: h.target, token: makeToken(), pageSummary: { page: 'p', asOf: 'now', data: [1] } }),
    /must be a plain object/)
})

test('open(): toolClass alone still works as before', async () => {
  const h = harness()
  const chat = await open({ target: h.target, token: makeToken(), toolClass: 'DemoTool' })
  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })
  await tick()
  assert.equal(h.submits()[0].toolClass, 'DemoTool')
  assert.equal(h.submits()[0].toolClasses, undefined)
  chat.destroy()
})
