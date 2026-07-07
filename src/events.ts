import type { ConfiqureMessage, ToolHandler, ToolContext } from './types.js'

type Handler = (data?: unknown) => void

export class EventBus {
  private handlers = new Map<string, Set<Handler>>()
  private messageListener: ((e: MessageEvent) => void) | null = null

  private tools: Record<string, ToolHandler> = {}
  private postToIframe: ((msg: object) => void) | null = null
  private toolTimeoutMs = 120_000
  private aborters = new Set<AbortController>()
  /**
   * #160 — sessionIds whose handler is currently running. The backend re-emits a
   * `frontend_tool_call` with the SAME sessionId on every stream reconnect (so a call dispatched
   * while a mobile browser had the stream suspended is not lost). While a session's handler is
   * still in flight (its popup open) we ignore the duplicate instead of rendering it twice. The
   * id is cleared when the handler settles — so a genuine re-dispatch after the page reloaded
   * finds an empty set and renders again (by then the old DOM state is gone anyway).
   */
  private inFlightTools = new Set<number>()

  constructor(private allowedOrigin: string) {}

  /** Wire frontend-tool handling: the map of handlers and how to reply to the iframe. */
  configureTools(tools: Record<string, ToolHandler>, postToIframe: (msg: object) => void, timeoutMs?: number): void {
    this.tools = tools ?? {}
    this.postToIframe = postToIframe
    if (typeof timeoutMs === 'number' && timeoutMs > 0) this.toolTimeoutMs = timeoutMs
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
  }

  /** Emit a locally-generated (host-side) error to 'error' subscribers — used by the ready watchdog. */
  emitError(code: string, message: string): void {
    this.emit('error', { code, message })
  }

  private emit(event: string, data?: unknown): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const h of set) {
      try { h(data) } catch { /* don't let one handler crash others */ }
    }
  }

  startListening(): void {
    this.messageListener = (e: MessageEvent) => {
      if (e.origin !== this.allowedOrigin) return
      const msg = e.data as ConfiqureMessage
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('confiqure:')) return

      const event = msg.type.replace('confiqure:', '')
      switch (event) {
        case 'ready':
          this.emit('ready')
          break
        case 'complete':
          // The iframe posts the finalized instance keys; the host pulls values via
          // GET /objects/{key}. (The old `values` payload was never populated — the
          // iframe has sent confiqureKeys since the per-turn-save migration.)
          this.emit('complete', { confiqureKeys: msg.confiqureKeys ?? [] })
          break
        case 'error':
          this.emit('error', { code: msg.code ?? 'UNKNOWN', message: msg.message ?? '' })
          break
        case 'closed':
          this.emit('closed', { reason: msg.reason ?? 'unknown' })
          break
        case 'resize':
          this.emit('resize', { height: msg.height ?? 0 })
          break
        case 'tool':
          this.handleToolCall(msg)
          break
      }
    }
    window.addEventListener('message', this.messageListener)
  }

  private handleToolCall(msg: ConfiqureMessage): void {
    const sessionId = msg.sessionId
    const toolName = msg.toolName ?? ''
    const reply = (payload: object) => {
      if (this.postToIframe) this.postToIframe({ type: 'confiqure:tool-result', sessionId, ...payload })
    }
    if (sessionId == null) return

    const handler = this.tools[toolName]
    if (!handler) {
      // #160: NACK immediately instead of leaving the session to hang for 5 minutes. A lost NACK is
      // harmless — the backend replays the call on reconnect and we NACK again (acceptReply is
      // idempotent), so this is deliberately NOT deduped below.
      console.warn(`confiqure: no handler registered for frontend tool "${toolName}"`)
      reply({ error: `No handler registered for tool "${toolName}" on this page` })
      return
    }

    // #160 dedupe: a reconnect replays the same frontend_tool_call. If this session's handler is
    // still running (its popup is open) ignore the duplicate — do NOT re-run the handler.
    if (this.inFlightTools.has(sessionId)) return
    this.inFlightTools.add(sessionId)

    const aborter = new AbortController()
    this.aborters.add(aborter)
    const timer = setTimeout(() => aborter.abort(new Error('tool handler timed out')), this.toolTimeoutMs)
    const cleanup = () => { clearTimeout(timer); this.aborters.delete(aborter); this.inFlightTools.delete(sessionId) }

    const ctx: ToolContext = {
      input: msg.input,
      endUserHandle: msg.endUserHandle,
      conversationId: msg.conversationId ?? 0,
      workspaceKey: msg.workspaceKey ?? '',
      progress: (message: string) => {
        if (this.postToIframe) this.postToIframe({ type: 'confiqure:tool-progress', sessionId, message })
      },
      signal: aborter.signal
    }

    Promise.resolve()
      .then(() => handler(msg.input, ctx))
      .then((result) => { cleanup(); reply({ result: result ?? null }) })
      .catch((err) => {
        cleanup()
        const message = err instanceof Error ? err.message : String(err)
        console.error(`confiqure: frontend tool "${toolName}" failed:`, err)
        reply({ error: message })
      })
  }

  stopListening(): void {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener)
      this.messageListener = null
    }
    for (const a of this.aborters) {
      try { a.abort(new Error('confiqure widget destroyed')) } catch { /* best effort */ }
    }
    this.aborters.clear()
    this.inFlightTools.clear()
    this.handlers.clear()
  }
}
