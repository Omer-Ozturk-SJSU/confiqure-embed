// #322 SDK regression — an embed chat must not die when its token's TTL runs out.
//
// The bug: the SDK minted ONE token at load and never thought about it again. Sixty minutes
// later the open chat was silently dead — the user's next message 401'd, the raw error (with the
// full JWT in the URL) rendered into the transcript, and the message was lost. A production
// support report and a lost repricer configuration both trace to this.
//
// The fix is two paths sharing one timer and one single-flight mint: a PROACTIVE re-mint ~2 min
// before `exp`, and a REACTIVE re-mint when the widget reports a 401 TOKEN_EXPIRED. Both go
// through the host's OWN tokenUrl (the same call used at load) — no new confiqure API.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { init } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'
const TOKEN_URL = 'https://host.example/confiqure-token'

/** A token whose `exp` is `ttlSeconds` from now — the SDK reads exp to schedule the re-mint. */
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

/** Mount through the host's tokenUrl — the only shape that CAN be refreshed. */
async function mountWithTokenUrl(h) {
  const chat = await init({
    target: h.target,
    tokenUrl: TOKEN_URL,
    endUserHandle: 'user-2',
    configEnd: '/restock'
  })
  h.fire({ type: 'confiqure:ready' })
  return chat
}

test('a short-TTL token re-mints once at the halfway clamp — never in a hot loop', async () => {
  // 4s TTL: exp-2min is far in the PAST, so an unclamped timer would fire immediately and keep
  // firing on every freshly minted (also-4s) token. The clamp says "never before half of what's
  // left", so the re-mint lands at ~2s and exactly once inside the window.
  const h = harness({ ttlSeconds: 4 })
  const chat = await mountWithTokenUrl(h)
  assert.equal(h.mints.length, 1, 'the load-time mint')
  assert.equal(h.refreshes().length, 0, 'nothing refreshed yet')

  await after(2400)

  assert.equal(h.mints.length, 2, 'exactly ONE proactive re-mint — the clamp held')
  const refresh = h.refreshes()
  assert.equal(refresh.length, 1, 'the fresh token was delivered to the widget')
  assert.equal(refresh[0].token, h.mints[1], 'and it is the token the host just minted')
  chat.destroy()
})

test('a long-TTL token does not re-mint anywhere near mount', async () => {
  const h = harness({ ttlSeconds: 3600 })
  const chat = await mountWithTokenUrl(h)
  await after(300)
  assert.equal(h.mints.length, 1, 'an hour-long token is left alone')
  assert.equal(h.refreshes().length, 0)
  chat.destroy()
})

test('the widget reporting expiry gets one re-mint and the new token back', async () => {
  const h = harness({ ttlSeconds: 3600 })
  const chat = await mountWithTokenUrl(h)

  h.fire({ type: 'confiqure:token-expired' })
  await tick()

  assert.equal(h.mints.length, 2, 'one re-mint, through the host\'s own tokenUrl')
  assert.equal(h.refreshes().length, 1)
  assert.equal(h.refreshes()[0].token, h.mints[1])
  assert.equal(h.failures().length, 0)
  chat.destroy()
})

test('concurrent expiry reports share ONE mint (single-flight)', async () => {
  const h = harness({ ttlSeconds: 3600 })
  const chat = await mountWithTokenUrl(h)

  // Two chat calls can 401 in the same tick (a send plus a stream reattach).
  h.fire({ type: 'confiqure:token-expired' })
  h.fire({ type: 'confiqure:token-expired' })
  h.fire({ type: 'confiqure:token-expired' })
  await tick()

  assert.equal(h.mints.length, 2, 'the load mint plus exactly one re-mint for all three reports')
  assert.equal(h.refreshes().length, 1, 'one answer, not three')
  chat.destroy()
})

test('a failed mint answers refresh-failed — the widget is never left waiting', async () => {
  const h = harness({ ttlSeconds: 3600, mintFails: true })
  // The load-time fetch must succeed, so only flip the failure on after mount.
  h.mints.push('bootstrap')
  const chat = await init({
    target: h.target,
    token: makeToken(3600),
    tokenUrl: TOKEN_URL,
    endUserHandle: 'user-2',
    configEnd: '/restock'
  })
  h.fire({ type: 'confiqure:ready' })

  const { errors } = await capturingConsole(async () => {
    h.fire({ type: 'confiqure:token-expired' })
    await tick()
    await tick()
  })

  assert.equal(h.refreshes().length, 0, 'no token to deliver')
  assert.equal(h.failures().length, 1, 'the widget is told, so it can show "please refresh"')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /could not refresh the chat session token/i)
  chat.destroy()
})

test('a widget mounted with a literal token cannot be refreshed — it says so, once, loudly', async () => {
  const h = harness({ ttlSeconds: 3600 })
  const chat = await init({ target: h.target, token: makeToken(3600) })
  h.fire({ type: 'confiqure:ready' })

  const { errors } = await capturingConsole(async () => {
    h.fire({ type: 'confiqure:token-expired' })
    await tick()
  })

  assert.equal(h.mints.length, 0, 'there is no mint path to call')
  assert.equal(h.failures().length, 1, 'answered anyway — an unanswered request hangs the widget')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /literal `token`/)
  assert.match(errors[0], /tokenUrl/)
  chat.destroy()
})

test('destroy() cancels the proactive refresh — a torn-down widget stops minting', async () => {
  const h = harness({ ttlSeconds: 4 })
  const chat = await mountWithTokenUrl(h)
  chat.destroy()

  await after(2400)

  assert.equal(h.mints.length, 1, 'no re-mint after teardown')
  assert.equal(h.refreshes().length, 0)
})
