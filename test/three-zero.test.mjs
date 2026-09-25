// Annotation 3.0 — the SDK half of the opening context (spec §5).
//
// A 3.0 host token names no endpoint: no `configEnd` claim, and the mint refuses `configEnd`.
// So the SDK must mount on such a token (the chat opens at the workspace root), must re-mint
// through tokenUrl with endUserHandle alone, and open() carries the optional `toolClass` — a
// tool-class name the screen opens the chat with — through the same post-open hand-off as
// intent/referentKeys/data. Browser operations of a tool class reach the page as
// "ToolClassName.operationName"; handlers are keyed by that name.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step), like the other tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open, init } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'

/** A 3.0 host token: workspaceKey only — no configEnd claim. */
function makeToken(claims = { workspaceKey: 'wkey12', endUserHandle: 'u-1' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

function harness() {
  let listener = null
  const posted = []
  const fetches = []
  const iframe = {
    src: '',
    style: {},
    setAttribute() {},
    remove() {},
    contentWindow: { postMessage: (msg) => posted.push(msg) }
  }
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => {}
  }
  globalThis.document = { createElement: () => iframe, querySelector: () => null }
  globalThis.fetch = async (url) => {
    fetches.push(String(url))
    if (String(url).startsWith('/token')) return { ok: true, json: async () => ({ token: makeToken() }) }
    return { ok: true, json: async () => [] }
  }
  return {
    target: { appendChild() {} },
    iframe,
    fire: (data) => listener?.({ origin: ORIGIN, data }),
    posted: () => posted,
    fetches: () => fetches
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('a 3.0 token with no configEnd claim mounts at the workspace root', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  const src = new URL(h.iframe.src)
  assert.equal(src.origin + src.pathname, `${ORIGIN}/wkey12`, 'iframe opens at /{workspaceKey}, no endpoint segment')
  await tick()
  const discovery = h.fetches().find((u) => u.includes('/frontend-tools'))
  assert.ok(discovery?.startsWith('https://api.confiqure.ai/api/wkey12/chat/frontend-tools?'),
    'frontend-tools discovery uses /api/{ws}/chat with no endpoint segment')
  chat.destroy()
})

test('tokenUrl needs only endUserHandle and never forwards configEnd', async () => {
  const h = harness()
  const chat = await init({ target: h.target, tokenUrl: '/token', endUserHandle: 'u-1' })
  const mint = new URL(h.fetches().find((u) => u.startsWith('/token')), 'https://host.example')
  assert.equal(mint.searchParams.get('endUserHandle'), 'u-1')
  assert.equal(mint.searchParams.has('configEnd'), false, 'configEnd is never sent to the mint')
  chat.destroy()
})

test('open({ toolClass }) hands the tool class to the chat with the rest of the context', async () => {
  const h = harness()
  const chat = await open({
    target: h.target,
    token: makeToken(),
    intent: 'The user opened the chat from the Listings page.',
    toolClass: 'ListingsTool'
  })
  assert.equal(new URL(h.iframe.src).searchParams.get('ps'), '1', 'a hand-off follows this open')
  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })
  await tick()
  const sent = h.posted().filter((m) => m.type === 'confiqure:submit')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].toolClass, 'ListingsTool')
  assert.equal(sent[0].intent, 'The user opened the chat from the Listings page.')
  chat.destroy()
})

test('open({ toolClass }) alone is a hand-off', async () => {
  const h = harness()
  const chat = await open({ target: h.target, token: makeToken(), toolClass: 'ListingsTool' })
  assert.equal(typeof chat.submission?.then, 'function', 'a tool class alone opens the hand-off')
  h.fire({ type: 'confiqure:submit-ready', conversationId: 1 })
  await tick()
  const sent = h.posted().filter((m) => m.type === 'confiqure:submit')
  assert.deepEqual(sent.map((m) => m.toolClass), ['ListingsTool'])
  chat.destroy()
})

test('a blank toolClass is not a hand-off', async () => {
  const h = harness()
  const chat = await open({ target: h.target, token: makeToken(), toolClass: '  ' })
  assert.equal(chat.submission, null)
  assert.equal(new URL(h.iframe.src).searchParams.has('ps'), false)
  chat.destroy()
})

test('a browser operation runs the handler keyed "ToolClassName.operationName"', async () => {
  const h = harness()
  let got = null
  const chat = await init({
    target: h.target,
    token: makeToken(),
    tools: { 'ListingsTool.openProduct360': async (input) => { got = input; return { ok: true } } }
  })
  h.fire({ type: 'confiqure:tool', toolName: 'ListingsTool.openProduct360', sessionId: 7, input: { sku: 'A-1' } })
  await tick(); await tick()
  assert.deepEqual(got, { sku: 'A-1' })
  const result = h.posted().find((m) => m.type === 'confiqure:tool-result' && m.sessionId === 7)
  assert.deepEqual(result?.result, { ok: true })
  chat.destroy()
})
