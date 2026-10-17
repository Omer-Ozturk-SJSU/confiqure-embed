// embed 0.4.0 — chat.setProgress() feeds the chat's progress strip; chat.announce() posts one host
// line into the open chat over the hand-off road. Synthetic values only.
//
// Transport under test: setProgress() crosses as `confiqure:progress` { progress } (null clears) and
// is re-sent at `ready`; announce() crosses as `confiqure:submit` { intent } and settles on the next
// `confiqure:submit-result`, one at a time, after open()'s own hand-off.
//
// Runs against the BUILT output (dist/, produced by the pretest tsc step). Zero test deps.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../dist/index.js'

const ORIGIN = 'https://confiqure.ai'

function makeToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64({ workspaceKey: 'wkey12', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
}

function harness() {
  let listener = null
  const posted = []
  const iframe = {
    src: '', style: {}, isConnected: true, setAttribute() {},
    remove() { this.isConnected = false; this.contentWindow = null },
    contentWindow: { postMessage: (msg) => posted.push(msg) }
  }
  globalThis.window = {
    addEventListener: (type, l) => { if (type === 'message') listener = l },
    removeEventListener: () => { listener = null }
  }
  globalThis.document = { createElement: () => iframe, querySelector: () => null }
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  const fire = (data) => listener?.({ origin: ORIGIN, data })
  return {
    target: { appendChild() {} },
    posted,
    fire,
    ready: () => fire({ type: 'confiqure:ready' }),
    result: (r) => fire({ type: 'confiqure:submit-result', ...r }),
    progress: () => posted.filter((m) => m.type === 'confiqure:progress'),
    submits: () => posted.filter((m) => m.type === 'confiqure:submit')
  }
}

function quietly(fn) {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try { return { value: fn(), warnings } } finally { console.warn = realWarn }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const mount = (h, extra = {}) => open({ target: h.target, token: makeToken(), ...extra })

// ── setProgress ───────────────────────────────────────────────────────────────────────────────

test('setProgress: a valid progress crosses whole as confiqure:progress', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const p = { variant: 'bulkyProgressBar', title: 'Importing listings', stage: 'Reading', done: 40, total: 160, state: 'running', since: 1760000000000 }
  chat.setProgress(p)
  assert.deepEqual(h.progress().at(-1), { type: 'confiqure:progress', progress: p })
  chat.destroy()
})

test('setProgress: each bad half is warned and dropped; the rest applies', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const { warnings } = quietly(() => chat.setProgress({
    variant: 'pill', title: 'x'.repeat(121), stage: 'Reading', done: 2.5, total: -1, state: 'paused', since: 'yesterday'
  }))
  assert.deepEqual(h.progress().at(-1).progress, { stage: 'Reading' })
  assert.equal(warnings.length, 6)
  chat.destroy()
})

test('setProgress: a reason goes with failed only', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const { warnings } = quietly(() => chat.setProgress({ done: 3, total: 9, state: 'running', reason: 'A network error' }))
  assert.deepEqual(h.progress().at(-1).progress, { done: 3, total: 9, state: 'running' })
  assert.equal(warnings.length, 1)
  chat.setProgress({ done: 3, total: 9, state: 'failed', reason: 'A network error' })
  assert.equal(h.progress().at(-1).progress.reason, 'A network error')
  chat.destroy()
})

test('setProgress: null clears; a value that is not a progress is warned and changes nothing', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  chat.setProgress({ done: 1, total: 2 })
  chat.setProgress(null)
  assert.deepEqual(h.progress().at(-1), { type: 'confiqure:progress', progress: null })
  const n = h.progress().length
  for (const bad of ['half', 7, [1, 2], undefined]) {
    const { warnings } = quietly(() => chat.setProgress(bad))
    assert.equal(warnings.length, 1, String(bad))
  }
  assert.equal(h.progress().length, n)
  chat.destroy()
})

test('setProgress: a repeat of the same progress is not posted again', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  chat.setProgress({ done: 5, total: 10 })
  chat.setProgress({ total: 10, done: 5 })
  assert.equal(h.progress().length, 1)
  chat.destroy()
})

test('setProgress: the last progress is re-sent at ready (a reload repaints); a clear is not', async () => {
  const h = harness(); const chat = await mount(h)
  chat.setProgress({ title: 'Importing listings', done: 7, total: 70 })
  h.ready()
  assert.deepEqual(h.progress().at(-1).progress, { title: 'Importing listings', done: 7, total: 70 })
  chat.setProgress(null)
  const n = h.progress().length
  h.ready()
  assert.equal(h.progress().length, n)
  chat.destroy()
})

test('setProgress: after destroy() it does nothing', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  chat.destroy()
  chat.setProgress({ done: 1, total: 2 })
  assert.equal(h.progress().length, 0)
})

// ── announce ──────────────────────────────────────────────────────────────────────────────────

test('announce: an invalid text is warned and rejected, and nothing is posted', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  for (const bad of ['', '   ', 'x'.repeat(501), 42, null]) {
    const { value, warnings } = quietly(() => chat.announce(bad))
    await assert.rejects(value, /non-blank string of at most 500/)
    assert.equal(warnings.length, 1)
  }
  assert.equal(h.submits().length, 0)
  chat.destroy()
})

test('announce: waits for ready, posts an intent-only submit, resolves on the result', async () => {
  const h = harness(); const chat = await mount(h)
  const p = chat.announce('The import finished: 160 items are ready.')
  await flush()
  assert.equal(h.submits().length, 0)
  h.ready()
  assert.deepEqual(h.submits(), [{ type: 'confiqure:submit', intent: 'The import finished: 160 items are ready.' }])
  h.result({ ok: true, submissionId: null })
  const r = await p
  assert.equal(r.ok, true)
  chat.destroy()
})

test('announce: two announces go one at a time, in order', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const a = chat.announce('Stage one is done.')
  const b = chat.announce('Stage two is done.')
  assert.deepEqual(h.submits().map((m) => m.intent), ['Stage one is done.'])
  h.result({ ok: true, submissionId: null })
  assert.equal((await a).ok, true)
  assert.deepEqual(h.submits().map((m) => m.intent), ['Stage one is done.', 'Stage two is done.'])
  h.result({ ok: true, submissionId: null })
  assert.equal((await b).ok, true)
  chat.destroy()
})

test('announce: a refused announce rejects with the result, and the next one still goes', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const a = chat.announce('Stage one is done.')
  const b = chat.announce('Stage two is done.')
  h.result({ ok: false, error: 'Conversation is not open' })
  await assert.rejects(a, (e) => /announce\(\) rejected — Conversation is not open/.test(e.message) && e.result.ok === false)
  assert.equal(h.submits().length, 2)
  h.result({ ok: true, submissionId: null })
  assert.equal((await b).ok, true)
  chat.destroy()
})

test('announce: waits for open()\'s own hand-off to settle, so neither result is taken for the other', async () => {
  const h = harness(); const chat = await mount(h, { intent: 'Help me set up the import.' })
  h.ready()
  const a = chat.announce('The count is known: 160.')
  await flush()
  assert.equal(h.submits().length, 0)
  h.fire({ type: 'confiqure:submit-ready', conversationId: 9 })
  assert.deepEqual(h.submits().map((m) => m.intent), ['Help me set up the import.'])
  h.result({ ok: true, submissionId: null })
  assert.equal((await chat.submission).ok, true)
  await flush()
  assert.deepEqual(h.submits().map((m) => m.intent), ['Help me set up the import.', 'The count is known: 160.'])
  h.result({ ok: true, submissionId: null })
  assert.equal((await a).ok, true)
  chat.destroy()
})

test('announce: a closed chat rejects the waiting and the later announces', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const a = chat.announce('Stage one is done.')
  h.fire({ type: 'confiqure:closed', reason: 'COMPLETED' })
  await assert.rejects(a, /the chat was closed/)
  await assert.rejects(chat.announce('Stage two is done.'), /the chat was closed/)
  chat.destroy()
})

test('announce: a user close (the phone hide) is not an ending — the queue keeps going', async () => {
  const h = harness(); const chat = await mount(h); h.ready()
  const a = chat.announce('Stage one is done.')
  h.fire({ type: 'confiqure:closed', reason: 'user' })
  h.result({ ok: true, submissionId: null })
  assert.equal((await a).ok, true)
  const b = chat.announce('Stage two is done.')
  assert.equal(h.posted.filter(m => m.type === 'confiqure:submit').at(-1).intent, 'Stage two is done.')
  h.result({ ok: true, submissionId: null })
  assert.equal((await b).ok, true)
  // a terminal reason after it still latches
  const c = chat.announce('Stage three is done.')
  h.fire({ type: 'confiqure:closed', reason: 'complete' })
  await assert.rejects(c, /the chat was closed/)
  await assert.rejects(chat.announce('Stage four is done.'), /the chat was closed/)
  chat.destroy()
})

test('announce: destroy() rejects what is queued, and later calls reject', async () => {
  const h = harness(); const chat = await mount(h)
  const a = chat.announce('Stage one is done.')
  chat.destroy()
  await assert.rejects(a, /the chat was destroyed/)
  await assert.rejects(chat.announce('Stage two is done.'), /the chat was destroyed/)
})

test('announce: a chat that never becomes ready (a closed pane) rejects instead of hanging', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const realError = console.error
  console.error = () => {}
  try {
    const h = harness(); const chat = await mount(h)
    chat.on('error', () => {})
    const a = chat.announce('Stage one is done.')
    mock.timers.tick(8000)
    await assert.rejects(a, /did not become ready/)
    await assert.rejects(chat.announce('Stage two is done.'), /did not become ready/)
    chat.destroy()
  } finally {
    console.error = realError
    mock.timers.reset()
  }
})
