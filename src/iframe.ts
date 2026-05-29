export interface IframeOptions {
  baseUrl: string
  token: string
  workspaceKey: string
  configEnd: string
  theme: string
  autoResize: boolean
}

export function createIframe(container: HTMLElement, opts: IframeOptions): HTMLIFrameElement {
  const slug = opts.configEnd.replace(/\//g, '-').replace(/^-/, '')
  const params = new URLSearchParams({ t: opts.token })
  if (opts.theme !== 'auto') params.set('theme', opts.theme)
  const src = `${opts.baseUrl}/${opts.workspaceKey}/chat-${slug}?${params}`

  const iframe = document.createElement('iframe')
  iframe.src = src
  iframe.style.border = 'none'
  iframe.style.width = '100%'
  iframe.setAttribute('allow', 'clipboard-write')
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
