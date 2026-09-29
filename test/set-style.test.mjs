// accent + setStyle() — the host hands the chat ONE accent hue (and its colour mode), at open and
// live. The widget keeps its own light/dark surfaces and paints its accented parts with the hue.
//
// Transport under test: the open-time accent rides the iframe URL as `accent=`; a later
// setStyle() crosses as a `confiqure:style` message and is re-sent at `ready` (postMessage does not
// buffer) — the same two paths `theme` / setTheme() use.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { init, open } from '../dist/index.js'
import { isCssColor } from '../dist/color.js'

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
    styles: () => posted.filter((m) => m.type === 'confiqure:style'),
    themes: () => posted.filter((m) => m.type === 'confiqure:theme')
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

const accentParam = (h) => new URL(h.iframe.src).searchParams.get('accent')

// ── the colour rule (shared, verbatim, with the widget's utils/widgetTheme.ts) ──────────────────

const VALID = [
  '#abc', '#ABCD', '#6b5bff', '#6B5BFF80',
  'rgb(107, 91, 255)', 'rgba(107,91,255,0.5)', 'rgb(40%, 30%, 100%)', 'rgb(107 91 255)',
  'rgb(107 91 255 / 50%)', 'rgba(107 91 255 / .5)',
  'hsl(246, 100%, 68%)', 'hsla(246deg, 100%, 68%, 0.8)', 'hsl(246 100% 68%)', 'hsl(-30 50% 50% / 1)',
  'hsl(0.5turn 60% 40%)', 'HSL(246, 100%, 68%)',
  'rgb(1\t2\n3)', 'rgb(1,\f2,\r3)'
]
const INVALID = [
  '', ' #6b5bff', '6b5bff', '#12', '#12345', '#1234567', '#ggg', 'red', 'transparent', 'currentColor',
  'var(--brand)', 'color-mix(in srgb, red, blue)', 'rgb(107, 91)', 'rgb(107, 91%, 255)',
  'rgb(1,2,3);background:url(x)', 'rgb(1 2 3) ', 'hsl(246, 100, 68)', 'hsl(246 100 68)',
  'rgb(1e2, 0, 0)', 'oklch(60% .2 280)', 'linear-gradient(red, blue)', '#' + 'a'.repeat(64),
  'rgb(' + '1'.repeat(70) + ', 0, 0)',
  // whitespace CSS does not parse between channels: NBSP, VT, U+2028, BOM, U+3000, U+1680
  'rgb(1\u00a02\u00a03)', 'rgb(107\u00a091\u00a0255)', 'rgb(1\v2\v3)', 'hsl(1\u20282%\u20283%)',
  'rgb(1,\ufeff2,3)', 'hsl(1\u30002%\u30003%)', 'rgb(1\u16802\u16803)',
  null, undefined, 0x6b5bff, {}, ['#fff']
]

test('isCssColor accepts hex 3/4/6/8 and rgb()/hsl() forms', () => {
  for (const v of VALID) assert.equal(isCssColor(v), true, `should accept ${JSON.stringify(v)}`)
})

test('isCssColor refuses everything else — named colours, var(), injections, non-strings', () => {
  for (const v of INVALID) assert.equal(isCssColor(v), false, `should refuse ${JSON.stringify(v)}`)
})

// ── open-time accent: the URL ───────────────────────────────────────────────────────────────────

test('the open-time accent rides the iframe URL as accent=, URL-encoded', async () => {
  const h = harness()
  const chat = await open({ target: h.target, token: makeToken(), accent: '#6b5bff' })
  assert.ok(h.iframe.src.includes('accent=%236b5bff'), h.iframe.src)
  assert.equal(accentParam(h), '#6b5bff')
  chat.destroy()
})

test('an rgb()/hsl() accent survives the URL round trip exactly', async () => {
  for (const accent of ['rgb(107 91 255 / 50%)', 'hsl(246, 100%, 68%)']) {
    const h = harness()
    const chat = await init({ target: h.target, token: makeToken(), accent })
    assert.equal(accentParam(h), accent)
    chat.destroy()
  }
})

test('surrounding whitespace is forgiven (a getPropertyValue read carries a leading space)', async () => {
  for (const accent of [' #6b5bff\n', '\u00a0#6b5bff\ufeff']) {
    const h = harness()
    const chat = await init({ target: h.target, token: makeToken(), accent })
    assert.equal(accentParam(h), '#6b5bff')
    chat.destroy()
  }
})

test('whitespace CSS does not parse INSIDE the value is refused, not passed to the chat', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  const { warnings } = quietly(() => chat.setStyle({ accent: 'rgb(107\u00a091\u00a0255)' }))
  assert.equal(h.styles().length, 0)
  assert.equal(warnings.length, 1)
  chat.destroy()
})

test('an invalid open-time accent is warned about and left off the URL', async () => {
  const h = harness()
  const { value: chat, warnings } = await quietlyAsync(() =>
    init({ target: h.target, token: makeToken(), accent: 'var(--brand)' }))
  assert.equal(accentParam(h), null)
  assert.ok(warnings.some((w) => w.includes('accent') && w.includes('var(--brand)')), warnings.join('\n'))
  chat.destroy()
})

test('no accent option → no accent param and no warning', async () => {
  const h = harness()
  const { value: chat, warnings } = await quietlyAsync(() => init({ target: h.target, token: makeToken() }))
  assert.equal(accentParam(h), null)
  assert.equal(warnings.length, 0)
  chat.destroy()
})

// ── setStyle(): live ────────────────────────────────────────────────────────────────────────────

test('setStyle posts confiqure:style with the theme, the accent, or both', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  chat.setStyle({ accent: '#ff6600' })
  chat.setStyle({ theme: 'dark' })
  chat.setStyle({ theme: 'light', accent: 'hsl(200 80% 40%)' })
  assert.deepEqual(h.styles().map(({ type, ...rest }) => rest), [
    { accent: '#ff6600' },
    { theme: 'dark' },
    { theme: 'light', accent: 'hsl(200 80% 40%)' }
  ])
  assert.equal(h.themes().length, 0, 'setStyle speaks confiqure:style only')
  chat.destroy()
})

test('an invalid half is warned about and dropped; the valid half still applies', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  const a = quietly(() => chat.setStyle({ theme: 'dark', accent: 'purple' }))
  const b = quietly(() => chat.setStyle({ theme: 'sepia', accent: '#123456' }))
  assert.deepEqual(h.styles().map(({ type, ...rest }) => rest), [{ theme: 'dark' }, { accent: '#123456' }])
  assert.ok(a.warnings.some((w) => w.includes('setStyle() accent') && w.includes('purple')), a.warnings.join('\n'))
  assert.ok(b.warnings.some((w) => w.includes('setStyle()') && w.includes('sepia')), b.warnings.join('\n'))
  chat.destroy()
})

test('a setStyle with nothing valid posts nothing and says why', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  const calls = [{}, null, 'dark', { accent: 'red' }, { theme: 'Dark' }]
  const warnings = calls.flatMap((c) => quietly(() => chat.setStyle(c)).warnings)
  assert.equal(h.styles().length, 0)
  assert.equal(warnings.length, calls.length, warnings.join('\n'))
  chat.destroy()
})

test('a setStyle accent before ready is re-sent at ready (postMessage does not buffer)', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), accent: '#111111' })
  chat.setStyle({ accent: '#6b5bff' })         // the widget may not be listening yet
  h.ready()
  assert.deepEqual(h.styles().at(-1), { type: 'confiqure:style', accent: '#6b5bff' })
  chat.destroy()
})

test('a setStyle theme before ready is re-sent at ready, exactly as setTheme is', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), theme: 'dark' })
  chat.setStyle({ theme: 'light' })
  h.ready()
  assert.equal(h.themes().at(-1)?.theme, 'light')
  chat.destroy()
})

test('nothing is re-sent at ready when the host never changed the open-time accent', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken(), accent: '#6b5bff' })
  h.ready()
  assert.equal(h.styles().length, 0, 'the URL already carries it')
  chat.setStyle({ accent: '#6b5bff' })          // live, after ready: posted as asked
  assert.equal(h.styles().length, 1)
  chat.destroy()
})

test('setStyle after destroy is a silent no-op', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  chat.destroy()
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try { chat.setStyle({ theme: 'light', accent: '#6b5bff' }) } finally { console.error = realError }
  assert.equal(h.styles().length, 0)
  assert.equal(errors.length, 0, 'no "iframe is gone" error for a style change')
})

test('setTheme is unchanged: it still speaks confiqure:theme (older widgets follow it)', async () => {
  const h = harness()
  const chat = await init({ target: h.target, token: makeToken() })
  h.ready()
  chat.setTheme('dark')
  assert.deepEqual(h.themes(), [{ type: 'confiqure:theme', theme: 'dark' }])
  assert.equal(h.styles().length, 0)
  chat.destroy()
})
