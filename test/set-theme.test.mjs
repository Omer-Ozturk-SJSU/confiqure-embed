// setTheme() — the host's own theme toggle drives the chat live (no reload).
//
// The bug it closes: a host with an in-app light/dark switch (EaseList) passed theme 'auto', so the
// widget followed the visitor's OS and stayed dark on a light app. The init option fixes the OPEN
// state; setTheme() keeps the chat in step when the user flips the host's toggle afterwards.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { init } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'
const TOKEN_URL = 'https://host.example/confiqure-token'

function makeToken(ttlSeconds, tag = 'a') {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  const claims = {
    workspaceKey: 'wkey12',
    configEnd: 'restock',
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    tag
  }
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

/**
 * Stub window + document so init() runs its REAL path, with a fetch that serves BOTH the host's
 * token endpoint and the frontend-tools discovery call.
 *
 *  - mints: every token the host endpoint handed out (length == number of re-mints + the load one)
 *  - refreshes(): the confiqure:token-refresh messages posted into the iframe
 *  - failures(): the confiqure:token-refresh-failed messages
 */
function harness({ ttlSeconds = 3600, mintFails = false } = {}) {
  let listener = null
  const posted = []
  const mints = []
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
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TOKEN_URL)) {
      if (mintFails) return { ok: false, status: 503, statusText: 'Service Unavailable' }
      const tok = makeToken(ttlSeconds, `mint-${mints.length + 1}`)
      mints.push(tok)
      return { ok: true, json: async () => ({ token: tok }) }
    }
    return { ok: true, json: async () => [] }   // frontend-tools discovery
  }

  return {
    target: { appendChild() {} },
    iframe,
    posted,
    mints,
    fire: (data) => listener?.({ origin: ORIGIN, data }),
    refreshes: () => posted.filter((m) => m.type === 'confiqure:token-refresh'),
    failures: () => posted.filter((m) => m.type === 'confiqure:token-refresh-failed')
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const after = (ms) => new Promise((r) => setTimeout(r, ms))

async function capturingConsole(fn) {
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.map(String).join(' '))
  try { return { value: await fn(), errors } }
  finally { console.error = realError }
}

const themes = (h) => h.posted.filter((m) => m.type === 'confiqure:theme')

async function mount(h, opts = {}) {
  return init({ target: h.target, token: makeToken(3600), ...opts })
}

test('setTheme posts the new mode into the chat iframe', async () => {
  const h = harness()
  const chat = await mount(h, { theme: 'auto' })
  h.fire({ type: 'confiqure:ready' })
  chat.setTheme('light')
  chat.setTheme('dark')
  assert.deepEqual(themes(h).map((m) => m.theme), ['light', 'dark'])
  chat.destroy()
})

test('a setTheme before ready is re-sent at ready (postMessage does not buffer)', async () => {
  const h = harness()
  const chat = await mount(h, { theme: 'dark' })
  chat.setTheme('light')                 // the widget may not be listening yet
  h.fire({ type: 'confiqure:ready' })
  const sent = themes(h).map((m) => m.theme)
  assert.equal(sent.at(-1), 'light', 'the mode the host asked for is delivered once the chat is ready')
  chat.destroy()
})

test('no theme message at ready when the host never switched away from the init value', async () => {
  const h = harness()
  const chat = await mount(h, { theme: 'dark' })
  h.fire({ type: 'confiqure:ready' })
  assert.equal(themes(h).length, 0, 'the URL already carries the init theme')
  chat.destroy()
})

test('an invalid value is warned about and ignored', async () => {
  const h = harness()
  const chat = await mount(h)
  h.fire({ type: 'confiqure:ready' })
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try { chat.setTheme('purple') } finally { console.warn = realWarn }
  assert.equal(themes(h).length, 0)
  assert.ok(warnings.some((w) => w.includes('setTheme()')), 'the host sees why nothing happened')
  chat.destroy()
})

test('setTheme after destroy is a silent no-op', async () => {
  const h = harness()
  const chat = await mount(h)
  h.fire({ type: 'confiqure:ready' })
  chat.destroy()
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try { chat.setTheme('light') } finally { console.error = realError }
  assert.equal(themes(h).length, 0)
  assert.equal(errors.length, 0, 'no "iframe is gone" error for a theme change')
})
