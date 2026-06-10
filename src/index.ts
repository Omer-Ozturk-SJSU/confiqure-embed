import type { ConfiqureInitOptions, ConfiqureChat } from './types.js'
import { fetchToken, decodeTokenClaims } from './token.js'
import { EventBus } from './events.js'
import { createIframe, destroyIframe } from './iframe.js'

const DEFAULT_BASE_URL = 'https://confiqure.ai'

async function init(options: ConfiqureInitOptions): Promise<ConfiqureChat> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
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

  const iframe = createIframe(container, {
    baseUrl,
    token,
    workspaceKey: claims.workspaceKey,
    configEnd: claims.configEnd,
    theme,
    autoResize
  })

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
  void validateToolHandlers(baseUrl, claims.workspaceKey, slug, token, Object.keys(tools))

  const chat: ConfiqureChat = {
    on(event: string, handler: (data?: any) => void) {
      bus.on(event, handler)
      return chat
    },
    destroy() {
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
  baseUrl: string,
  workspaceKey: string,
  configName: string,
  token: string,
  registered: string[]
): Promise<void> {
  try {
    // The default endpoint (empty slug) is reached at /api/{ws}/chat/... with NO segment;
    // named endpoints keep their slug. Matches the backend route (configName optional).
    const chatBase = configName
      ? `${baseUrl}/api/${workspaceKey}/chat/${configName}`
      : `${baseUrl}/api/${workspaceKey}/chat`
    const url = `${chatBase}/frontend-tools?t=${encodeURIComponent(token)}`
    const res = await fetch(url)
    if (!res.ok) return
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
