// Row 13529 — `confiqure:close-drawn`: the phone widget's own close button is drawn. The SDK emits
// `close-drawn` only for the configured origin AND this instance's own iframe; no payload; it is not
// readiness. Runs against the BUILT output (dist/). Synthetic values only. Zero test deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'

function makeToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64({ workspaceKey: 'wkey12', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
}

// One window, any number of frames: each open() gets its own iframe whose contentWindow is a distinct object.
function world({ onCreate } = {}) {
  const listeners = new Set()
  const frames = []
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listeners.add(l) },
    removeEventListener: (type, l) => { listeners.delete(l) }
  }
  globalThis.document = {
    createElement: () => {
      const iframe = {
        src: '', style: {}, isConnected: true, setAttribute() {},
        remove() { this.isConnected = false; this.contentWindow = null },
        contentWindow: { postMessage() {} }
      }
      frames.push(iframe)
      onCreate?.(iframe)
      return iframe
    },
    querySelector: () => null
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  const fire = (data, { origin = ORIGIN, source } = {}) => { for (const l of [...listeners]) l({ origin, data, source }) }
  return { frames, fire, target: { appendChild() {} } }
}

const drawn = { type: 'confiqure:close-drawn' }

test('close-drawn: from our own frame on the configured origin fires once, with no payload', async () => {
  const w = world(); const chat = await open({ target: w.target, token: makeToken() })
  const got = []
  chat.on('close-drawn', (data) => got.push(data))
  w.fire(drawn, { source: w.frames[0].contentWindow })
  assert.deepEqual(got, [undefined])
  chat.destroy()
})

test('close-drawn: a foreign origin is ignored', async () => {
  const w = world(); const chat = await open({ target: w.target, token: makeToken() })
  let n = 0; chat.on('close-drawn', () => n++)
  w.fire(drawn, { origin: 'https://evil.example', source: w.frames[0].contentWindow })
  assert.equal(n, 0)
  chat.destroy()
})

test('close-drawn: a foreign iframe on the same origin is ignored, and two instances stay apart', async () => {
  const w = world()
  const a = await open({ target: w.target, token: makeToken() })
  const b = await open({ target: w.target, token: makeToken() })
  let na = 0, nb = 0
  a.on('close-drawn', () => na++); b.on('close-drawn', () => nb++)
  w.fire(drawn, { source: { postMessage() {} } })      // some other frame
  w.fire(drawn)                                       // no source at all
  assert.deepEqual([na, nb], [0, 0])
  w.fire(drawn, { source: w.frames[1].contentWindow }) // b's own frame
  assert.deepEqual([na, nb], [0, 1])
  a.destroy(); b.destroy()
})

test('close-drawn: a duplicate signal just fires again (harmless)', async () => {
  const w = world(); const chat = await open({ target: w.target, token: makeToken() })
  let n = 0; chat.on('close-drawn', () => n++)
  const src = w.frames[0].contentWindow
  w.fire(drawn, { source: src }); w.fire(drawn, { source: src })
  assert.equal(n, 2)
  chat.destroy()
})

test('close-drawn: is not readiness — it fires without ready, and ready still fires on its own', async () => {
  const w = world(); const chat = await open({ target: w.target, token: makeToken() })
  const seen = []
  chat.on('close-drawn', () => seen.push('close-drawn')).on('ready', () => seen.push('ready'))
  const src = w.frames[0].contentWindow
  w.fire(drawn, { source: src })
  assert.deepEqual(seen, ['close-drawn'])
  w.fire({ type: 'confiqure:ready' }, { source: src })
  assert.deepEqual(seen, ['close-drawn', 'ready'])
  chat.destroy()
})

test('close-drawn: fast load — a signal posted as soon as the iframe exists reaches a listener registered right after await open()', async () => {
  let w
  w = world({ onCreate: (iframe) => setTimeout(() => w.fire(drawn, { source: iframe.contentWindow }), 0) })
  const chat = await open({ target: w.target, token: makeToken() })
  let n = 0; chat.on('close-drawn', () => n++)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(n, 1)
  chat.destroy()
})

test('close-drawn: a user close after it keeps the announce queue (75f2e3ec guard retained)', async () => {
  const w = world(); const chat = await open({ target: w.target, token: makeToken() })
  const src = w.frames[0].contentWindow
  w.fire({ type: 'confiqure:ready' }, { source: src })
  w.fire(drawn, { source: src })
  const a = chat.announce('Stage one is done.')
  w.fire({ type: 'confiqure:closed', reason: 'user' }, { source: src })
  w.fire({ type: 'confiqure:submit-result', ok: true, submissionId: null }, { source: src })
  assert.equal((await a).ok, true)
  chat.destroy()
})
