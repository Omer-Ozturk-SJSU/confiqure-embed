// look — the host picks one of the chat's ready-made looks (embed 0.3.2), at open and live.
//
// `theme` keeps its shipped meaning (the colour MODE); `look` is the kit-shaped token set, one of
// 'phosphor' | 'tairo' | 'shadcn' | 'material' | 'bootstrap'. Transport under test: the open-time
// look rides the iframe URL as `look=`; a later setStyle({ look }) crosses in the same
// `confiqure:style` message as the accent and is re-sent at `ready` (postMessage does not buffer).
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { init, open } from '../dist/index.js'
import { isLook, LOOKS } from '../dist/look.js'

const ORIGIN = 'https://confiqure.ai'

function makeToken(ttlSeconds = 3600) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  const claims = { workspaceKey: 'wkey12', exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

/** Stub window + document so init()/open() run their REAL path. */
function harness() {
  let listener = null
  const posted = []
  const iframe = {
    src: '',
    style: {},
    isConnected: true,
    setAttribute() {},
    remove() { this.isConnected = false; this.contentWindow = null },
    contentWindow: { postMessage: (msg) => posted.push(msg) }
  }
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => { listener = null }
  }
  globalThis.document = { createElement: () => iframe, querySelector: () => null }
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })   // frontend-tools discovery
  return {
    target: { appendChild() {} },
    iframe,
    posted,
    ready: () => listener?.({ origin: ORIGIN, data: { type: 'confiqure:ready' } }),
    styles: () => posted.filter((m) => m.type === 'confiqure:style')
  }
}

function quietly(fn) {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try { return { value: fn(), warnings } } finally { console.warn = realWarn }
}

async function quietlyAsync(fn) {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try { return { value: await fn(), warnings } } finally { console.warn = realWarn }
}

const param = (h, name) => new URL(h.iframe.src).searchParams.get(name)

// ── the names (shared with the widget's utils/widgetTheme.ts and the backend's WidgetLook) ──────

test('the five looks, phosphor first (the default)', () => {
  assert.deepEqual([...LOOKS], ['phosphor', 'tairo', 'shadcn', 'material', 'bootstrap'])
})

test('isLook accepts exactly the five names', () => {
  for (const ok of LOOKS) assert.equal(isLook(ok), true, ok)
  for (const bad of ['', 'Tairo', ' shadcn', 'shadcn ', 'mui', 'dark', 'light', null, undefined, 0, {}, ['tairo']]) {
    assert.equal(isLook(bad), false, `should refuse ${JSON.stringify(bad)}`)
  }
})

// ── open-time look: the URL ─────────────────────────────────────────────────────────────────────

test('the open-time look rides the iframe URL as look=, beside theme= and accent=', async () => {
  const h = harness()
  const chat = await open({ target: h.target, token: makeToken(), look: 'material', theme: 'dark', accent: '#6b5bff' })
  assert.equal(param(h, 'look'), 'material')
  assert.equal(param(h, 'theme'), 'dark', 'theme keeps its meaning: the mode')
  assert.equal(param(h, 'accent'), '#6b5bff')
  chat.destroy()
})

test('every look name reaches the URL unchanged', async () => {
  for (const look of LOOKS) {
    const h = harness()
    const chat = await init({ target: h.target, token: makeToken(), look })
    assert.equal(param(h, 'look'), look)
    chat.destroy()
  }
})

test('an unknown open-time look is warned about and left off the URL', async () => {
  for (const look of ['mui', 'Shadcn', 'dark', 42]) {
    const h = harness()
    const { value: chat, warnings } = await quietlyAsync(() => init({ target: h.target, token: makeToken(), look }))
    assert.equal(param(h, 'look'), null)
    assert.ok(warnings.some((w) => w.includes('look') && w.includes(JSON.stringify(look)) && w.includes("'bootstrap'")), warnings.join('\n'))
    chat.destroy()
  }
})

test('no look option → no look param and no warning (the dashboard setting decides)', async () => {
  const h = harness()
  const { value: chat, warnings } = await quietlyAsync(() => init({ target: h.target, token: makeToken() }))
  assert.equal(param(h, 'look'), null)
  assert.equal(warnings.length, 0)
  chat.destroy()
})

// ── setStyle({ look }): live ────────────────────────────────────────────────────────────────────

test('setStyle posts confiqure:style with the look, alone or with the mode and accent', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  chat.setStyle({ look: 'tairo' })
  chat.setStyle({ look: 'bootstrap', theme: 'light', accent: '#123456' })
  assert.deepEqual(h.styles().map(({ type, ...rest }) => rest), [
    { look: 'tairo' },
    { look: 'bootstrap', theme: 'light', accent: '#123456' }
  ])
  chat.destroy()
})

test('an unknown live look is warned about and dropped; the valid parts still apply', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  const a = quietly(() => chat.setStyle({ look: 'fluent', theme: 'dark' }))
  const b = quietly(() => chat.setStyle({ look: 'fluent' }))
  assert.deepEqual(h.styles().map(({ type, ...rest }) => rest), [{ theme: 'dark' }])
  assert.ok(a.warnings.some((w) => w.includes('setStyle() look') && w.includes('fluent')), a.warnings.join('\n'))
  assert.equal(b.warnings.length, 1, 'a call with nothing valid warns once and posts nothing')
  chat.destroy()
})

test('setStyle with none of look/theme/accent names all three in its warning', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  const { warnings } = quietly(() => chat.setStyle({ looks: 'tairo' }))
  assert.equal(h.styles().length, 0)
  assert.ok(warnings.some((w) => w.includes('{ look?, theme?, accent? }')), warnings.join('\n'))
  chat.destroy()
})

test('a setStyle look before ready is re-sent at ready, in one message with a changed accent', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), look: 'shadcn', accent: '#111111' })
  chat.setStyle({ look: 'material', accent: '#6b5bff' })   // the widget may not be listening yet
  h.ready()
  assert.deepEqual(h.styles().at(-1), { type: 'confiqure:style', look: 'material', accent: '#6b5bff' })
  chat.destroy()
})

test('only what changed is re-sent at ready', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), look: 'shadcn', accent: '#111111' })
  chat.setStyle({ look: 'tairo' })
  const before = h.styles().length
  h.ready()
  assert.deepEqual(h.styles().slice(before), [{ type: 'confiqure:style', look: 'tairo' }])
  chat.destroy()
})

test('nothing is re-sent at ready when the host never changed the open-time look', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), look: 'tairo' })
  h.ready()
  assert.equal(h.styles().length, 0, 'the URL already carries it')
  chat.destroy()
})

test('setStyle({ look }) after destroy is a silent no-op', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  chat.destroy()
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try { chat.setStyle({ look: 'material' }) } finally { console.error = realError }
  assert.equal(h.styles().length, 0)
  assert.equal(errors.length, 0)
})
