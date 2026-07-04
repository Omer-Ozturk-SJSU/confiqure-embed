import type { ConfiqureInitOptions, ConfiqureChat } from './types.js'
import { fetchToken, decodeTokenClaims } from './token.js'
import { EventBus } from './events.js'
import { createIframe, destroyIframe } from './iframe.js'

const DEFAULT_BASE_URL = 'https://confiqure.ai'
const DEFAULT_API_BASE_URL = 'https://api.confiqure.ai'

async function init(options: ConfiqureInitOptions): Promise<ConfiqureChat> {
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
    autoResize
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

  const chat: ConfiqureChat = {
    on(event: string, handler: (data?: any) => void) {
      bus.on(event, handler)
      return chat
    },
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

export { init }
export type { ConfiqureInitOptions, ConfiqureChat, ToolHandler, ToolContext } from './types.js'
