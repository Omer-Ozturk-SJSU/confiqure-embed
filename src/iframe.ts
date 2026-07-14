export interface IframeOptions {
  baseUrl: string
  token: string
  workspaceKey: string
  configEnd: string
  theme: string
  autoResize: boolean
  /** #190: per-tab conversation id, forwarded to the chat so it scopes resume to this tab. */
  tabId?: string
  /** #238: a confiqure.open() submit hand-off follows this open — the widget forwards it on
   *  /session (pendingSubmit) so the backend parks the opening turn for the announce. A
   *  protocol flag only; the content itself crosses via postMessage after `submit-ready`. */
  pendingSubmit?: boolean
}

export function createIframe(container: HTMLElement, opts: IframeOptions): HTMLIFrameElement {
  const slug = opts.configEnd.replace(/\//g, '-').replace(/^-/, '')
  const params = new URLSearchParams({ t: opts.token })
  if (opts.theme !== 'auto') params.set('theme', opts.theme)
  // #190: hand the per-tab id to the chat iframe. The chat forwards it on POST /session so the
  // backend keeps each browser tab in its own conversation space. Re-passed on every (re)mount, so
  // an iframe the host tears down and re-adds lands back on the same conversation.
  if (opts.tabId) params.set('tab', opts.tabId)
  // #238: flags the widget that a submit hand-off is coming (see IframeOptions.pendingSubmit).
  if (opts.pendingSubmit) params.set('ps', '1')
  // The default endpoint (configEnd "/") has an empty slug → it is reached at the workspace
  // root /{workspaceKey} with NO segment; named endpoints append their slug.
  const path = slug ? `${opts.workspaceKey}/${slug}` : opts.workspaceKey
  const src = `${opts.baseUrl}/${path}?${params}`

  const iframe = document.createElement('iframe')
  iframe.src = src
  iframe.style.border = 'none'
  iframe.style.width = '100%'
  // #201: delegate camera via permissions-policy so a token minted with camera:true can drive
  // getUserMedia take-photo inside the embedded chat. The embedding page still gates it — the
  // allow attribute only lets the browser prompt; the user grants. (mic stays out until needed.)
  iframe.setAttribute('allow', 'clipboard-write; camera')
  iframe.setAttribute('loading', 'lazy')

  if (opts.autoResize) {
    iframe.style.height = '0'
    iframe.style.overflow = 'hidden'
    iframe.style.transition = 'height 0.15s ease'
  } else {
    iframe.style.height = '100%'
  }

  container.appendChild(iframe)
  return iframe
}

export function destroyIframe(iframe: HTMLIFrameElement): void {
  iframe.remove()
}
