import type { ConfiqureInitOptions, ConfiqureOpenOptions, ConfiqureChat, SubmitResult } from './types.js'
import { fetchToken, decodeTokenClaims } from './token.js'
import { EventBus } from './events.js'
import { createIframe, destroyIframe } from './iframe.js'

const DEFAULT_BASE_URL = 'https://confiqure.ai'
const DEFAULT_API_BASE_URL = 'https://api.confiqure.ai'

// #190 per-tab conversation spaces: the tab id is minted HERE, in the host page's first-party
// top context, not inside the chat iframe. A third-party iframe's sessionStorage is
// storage-partitioned and, in privacy-hardened browsers, not reliably durable across re-mounts —
// so an iframe-side id would risk losing the conversation on a host re-mount / reload. First-party
// sessionStorage survives page reloads and every iframe re-mount within the tab, and is fresh in a
// new tab — exactly the per-tab lifetime we want.
const TAB_ID_KEY = 'confiqure.tabId'

function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through to the non-crypto id */ }
  return 't-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * Resolve this tab's stable per-tab id from first-party sessionStorage, minting one on first use.
 * Returns undefined when sessionStorage is unavailable or silently non-persistent (private modes,
 * blocked storage): we then send NO tab id, and the backend falls back to its pre-#190
 * tab-agnostic resume — strictly better than an ephemeral id that would fork the conversation on
 * every re-mount.
 */
function resolveTabId(): string | undefined {
  try {
    const store = window.sessionStorage
    const existing = store.getItem(TAB_ID_KEY)
    if (existing) return existing
    const id = newTabId()
    store.setItem(TAB_ID_KEY, id)
    // Read-back guard: some browsers expose a sessionStorage object that no-ops writes. If it
    // didn't persist we can't rely on it surviving a re-mount, so omit the id (legacy behavior).
    return store.getItem(TAB_ID_KEY) === id ? id : undefined
  } catch {
    return undefined
  }
}

/** #238 — the open() hand-off: everything contextual the host passes, delivered post-open. */
interface SubmitHandoff {
  intent?: string
  referentKeys?: string[]
  data?: Record<string, unknown>
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return `a ${typeof v}`
}

/**
 * #243 — normalize the open() `data` hand-off to a plain, structured-clone-safe object.
 *
 * Frameworks hand their state out as reactive **Proxies** (Vue `ref`/`reactive`, MobX, Angular
 * signals, …). `postMessage` — the only way `data` crosses into the chat iframe — runs the
 * structured-clone algorithm, and structuredClone CANNOT clone a Proxy: it throws
 * `DataCloneError`. Left unchecked that throw surfaces deep inside delivery, AFTER the hand-off is
 * marked spent, hanging `chat.submission` forever (the exact #243 failure). So we normalize here,
 * at the call site, with a JSON round-trip — it strips the proxy wrapper AND proves the payload is
 * JSON-serializable in one move. Anything that can't survive it — a non-object shape, an array, a
 * circular graph, a value JSON drops — THROWS a descriptive error (the #238 "a wrong shape rejects
 * deterministically in the dev's console" rule), never a silent drop.
 */
function normalizeHandoffData(raw: unknown): Record<string, unknown> {
  // Shape gate first: JSON.stringify would happily serialize an array or a primitive, so those
  // must be rejected before the round-trip, not after.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `confiqure: open({ data }) must be a plain object keyed by your endpoint's field names ` +
      `(e.g. { restockList: [...] }) — got ${describe(raw)}. Arrays and primitives are not valid hand-off shapes.`
    )
  }
  let plain: unknown
  try {
    // Un-proxies any reactive wrapper and validates JSON-serializability at once.
    plain = JSON.parse(JSON.stringify(raw))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `confiqure: open({ data }) is not JSON-serializable (${reason}). Pass a plain data object — ` +
      `no circular references, BigInt, or other non-serializable values.`
    )
  }
  // A value with a toJSON() (a bare Date, a boxed primitive) can collapse an object input down to a
  // scalar or array — the delivered hand-off must still be a plain object.
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    throw new Error(
      `confiqure: open({ data }) did not serialize to a plain object — got ${describe(plain)}. ` +
      `Pass the real DTO shape keyed by your endpoint's field names.`
    )
  }
  return plain as Record<string, unknown>
}

function extractHandoff(options: ConfiqureOpenOptions): SubmitHandoff | null {
  const hasIntent = typeof options.intent === 'string' && options.intent.trim().length > 0
  const hasRefs = Array.isArray(options.referentKeys) && options.referentKeys.length > 0
  // #243: normalize the data hand-off up front. A wrong shape or a non-cloneable reactive wrapper
  // THROWS here (rejecting the open() call in the host's console) instead of silently dropping or
  // hanging delivery later. An absent/empty data payload is not an error — it's simply no data.
  const data = options.data != null ? normalizeHandoffData(options.data) : undefined
  const hasData = data != null && Object.keys(data).length > 0
  if (!hasIntent && !hasRefs && !hasData) return null
  return {
    intent: hasIntent ? options.intent : undefined,
    referentKeys: hasRefs ? options.referentKeys : undefined,
    data: hasData ? data : undefined
  }
}

async function init(options: ConfiqureInitOptions): Promise<ConfiqureChat> {
  return mount(options, null)
}

/**
 * #238 — the ONE surface for opening a chat with context: `confiqure.open({ token, intent,
 * referentKeys, data })`. The session opens instantly (token-only — the chat paints
 * immediately); the context is then auto-submitted through the submit channel: `data` moves
 * as a single visible transfer (live progress block in the chat), is validated by the
 * endpoint's save gates server-side, and lands in the configuration draft. The chat model
 * receives a count-reference only — never the payload — so bulk hand-offs no longer ride
 * (or stall) the conversation. The outcome surfaces on the returned chat's `submission`
 * promise: a wrong shape or oversize payload rejects there, in your console, deterministically.
 *
 * `open()` without intent/referentKeys/data behaves exactly like `init()`.
 */
async function open(options: ConfiqureOpenOptions): Promise<ConfiqureChat> {
  return mount(options, extractHandoff(options))
}

async function mount(options: ConfiqureInitOptions, handoff: SubmitHandoff | null): Promise<ConfiqureChat> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')

  // Init guard (#154): baseUrl is the PAGE origin that frames the chat, never the API origin.
  // The API origin sends X-Frame-Options and can't be framed, so catch the mix-up loudly here.
  let baseHostname: string
  try {
    baseHostname = new URL(baseUrl).hostname
  } catch {
    throw new Error(`confiqure: baseUrl is not a valid URL: "${baseUrl}"`)
  }
  if (baseHostname.startsWith('api.') || baseUrl === apiBaseUrl) {
    throw new Error(
      `confiqure: baseUrl must be the confiqure page origin that serves the chat iframe ` +
      `(default 'https://confiqure.ai'), not the API origin — got '${baseUrl}'. ` +
      `Pass the API origin via the apiBaseUrl option instead. See https://confiqure.ai/docs/guides/embed`
    )
  }

  const theme = options.theme ?? 'auto'
  const autoResize = options.autoResize ?? false

  const container = typeof options.target === 'string'
    ? document.querySelector<HTMLElement>(options.target)
    : options.target
  if (!container) {
    throw new Error(`confiqure: target "${options.target}" not found`)
  }

  let token: string
  if (options.token) {
    token = options.token
  } else if (options.tokenUrl) {
    if (!options.endUserHandle || !options.configEnd) {
      throw new Error('confiqure: tokenUrl requires endUserHandle and configEnd')
    }
    token = await fetchToken(options.tokenUrl, options.endUserHandle, options.configEnd)
  } else {
    throw new Error('confiqure: either token or tokenUrl is required')
  }

  const claims = decodeTokenClaims(token)
  if (!claims || !claims.workspaceKey || !claims.configEnd) {
    throw new Error('confiqure: token is missing workspaceKey or configEnd claims')
  }

  const bus = new EventBus(baseUrl)
  bus.startListening()

  // Ready watchdog (#154): if the iframe never posts `ready`, the embed is almost always
  // misconfigured (wrong origin or blocked framing). Surface it instead of failing silently.
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let readyFired = false
  bus.on('ready', () => {
    readyFired = true
    clearTimeout(readyTimer)
  })

  const iframe = createIframe(container, {
    baseUrl,
    token,
    workspaceKey: claims.workspaceKey,
    configEnd: claims.configEnd,
    theme,
    autoResize,
    tabId: resolveTabId(),
    // #238: only the FLAG rides the URL — the hand-off content itself crosses via
    // postMessage after the widget signals `submit-ready` (nothing contextual in URLs).
    pendingSubmit: handoff != null
  })

  readyTimer = setTimeout(() => {
    if (readyFired) return
    console.error(
      'confiqure: chat iframe did not become ready within 8s. Likely causes: ' +
      '(1) wrong baseUrl — it must be the confiqure page origin that serves the chat (default https://confiqure.ai), not the API origin; ' +
      '(2) framing blocked by X-Frame-Options / CSP frame-ancestors on the chat page. ' +
      'Note: an intentionally offscreen or loading="lazy" iframe that has not scrolled into view can also trip this.'
    )
    bus.emitError('EMBED_NOT_READY', 'chat iframe did not become ready within 8s')
  }, 8000)

  if (autoResize) {
    bus.on('resize', (data) => {
      const d = data as { height: number }
      if (d.height > 0) {
        iframe.style.height = `${d.height}px`
      }
    })
  }

  // Frontend tools: run host handlers when the chat agent calls them, reply to the iframe.
  const tools = options.tools ?? {}
  bus.configureTools(
    tools,
    (msg) => iframe.contentWindow?.postMessage(msg, baseUrl),
    options.toolTimeoutMs
  )
  // Best-effort: warn at init about declared frontend tools with no registered handler,
  // so the gap is visible the moment the page loads rather than mid-chat.
  const slug = claims.configEnd.replace(/\//g, '-').replace(/^-/, '')
  void validateToolHandlers(apiBaseUrl, claims.workspaceKey, slug, token, Object.keys(tools))

  // #238: deliver the open() hand-off once the widget says it can receive it (session open +
  // bridge listener up — postMessage doesn't buffer), and surface the settled outcome as the
  // chat's `submission` promise. A refused submit (wrong shape, oversize, gate reject) REJECTS
  // — a loud, developer-facing failure in the host's console, not a model mistake mid-chat.
  let submission: Promise<SubmitResult> | null = null
  if (handoff) {
    let resolveSubmission!: (r: SubmitResult) => void
    let rejectSubmission!: (e: Error) => void
    submission = new Promise<SubmitResult>((resolve, reject) => {
      resolveSubmission = resolve
      rejectSubmission = reject
    })
    let handedOff = false
    bus.on('submit-ready', () => {
      // Once per mount: an iframe-internal reload re-signals readiness, but the hand-off is
      // spent — the data either landed already or failed visibly; never silently re-submit.
      if (handedOff) return
      handedOff = true
      // #243: the delivery postMessage can still throw — a value that slipped past extractHandoff's
      // JSON check but isn't structured-cloneable, or a torn-down contentWindow. Catch it and
      // REJECT the submission with the real error; never let a delivery failure hang the promise.
      try {
        iframe.contentWindow?.postMessage({ type: 'confiqure:submit', ...handoff }, baseUrl)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        rejectSubmission(new Error('confiqure: failed to deliver the open() hand-off to the chat — ' + reason))
      }
    })
    bus.on('submit_result', (data) => {
      const r = data as SubmitResult
      if (r.ok) {
        resolveSubmission(r)
      } else {
        const err = new Error('confiqure: submit rejected — '
          + (r.error ?? r.rejections?.map(x => `${x.fieldId ?? ''}: ${x.reason ?? ''}`).join('; ') ?? 'unknown')
        ) as Error & { result?: SubmitResult }
        err.result = r
        rejectSubmission(err)
      }
    })
  }

  const chat: ConfiqureChat = {
    on(event: string, handler: (data?: any) => void) {
      bus.on(event, handler)
      return chat
    },
    submission,
    destroy() {
      clearTimeout(readyTimer)
      bus.stopListening()
      destroyIframe(iframe)
    }
  }

  return chat
}

/**
 * Fetch the frontend tools this endpoint declares and warn about any without a
 * registered handler. Best-effort: any failure (network, auth, missing endpoint)
 * is swallowed — this is a dev convenience, never a hard dependency.
 */
async function validateToolHandlers(
  apiBaseUrl: string,
  workspaceKey: string,
  configName: string,
  token: string,
  registered: string[]
): Promise<void> {
  try {
    // The default endpoint (empty slug) is reached at /api/{ws}/chat/... with NO segment;
    // named endpoints keep their slug. Matches the backend route (configName optional).
    const chatBase = configName
      ? `${apiBaseUrl}/api/${workspaceKey}/chat/${configName}`
      : `${apiBaseUrl}/api/${workspaceKey}/chat`
    const url = `${chatBase}/frontend-tools?t=${encodeURIComponent(token)}`
    const res = await fetch(url)
    if (!res.ok) {
      console.warn('[confiqure] frontend-tools discovery failed: ' + res.status + ' ' + url)
      return
    }
    const declared = (await res.json()) as string[]
    if (!Array.isArray(declared)) return
    const have = new Set(registered)
    const missing = declared.filter((name) => !have.has(name))
    for (const name of missing) {
      console.warn(
        `confiqure: frontend tool "${name}" is declared on this endpoint but no handler was registered. ` +
        `Add it to confiqure.init({ tools: { ${name}: async (input, ctx) => { ... } } }) or run \`confiqure scaffold\`.`
      )
    }
  } catch {
    /* best effort — never block init on validation */
  }
}

export { init, open }
export type {
  ConfiqureInitOptions, ConfiqureOpenOptions, ConfiqureChat, SubmitResult,
  ToolHandler, ToolContext
} from './types.js'
