import type { ConfiqureMessage, ToolHandler, ToolContext } from './types.js'

type Handler = (data?: unknown) => void

/**
 * #321 — how long a posted tool result stays "awaiting the widget's ack" before we stop
 * tracking it. The widget acks AFTER its POST to the platform settles, so this only has to
 * cover one same-origin round trip. Older widget builds never ack at all: the grace timer is
 * what keeps a new SDK against an old widget from waiting forever.
 */
const ACK_GRACE_MS = 1000

/**
 * #321 — the hard cap on how long `destroy()` may defer teardown while it flushes in-flight
 * tool replies. Deliberately small: a host that unmounts as its tool's side effect should not
 * notice the delay, and a wedged reply must never hold the page's teardown open.
 */
export const FLUSH_CAP_MS = 2000

/**
 * #321 — outcome of a `destroy()` flush.
 * - `idle`         nothing was in flight; teardown was immediate
 * - `flushed`      every reply was delivered AND acked by the widget
 * - `unconfirmed`  everything cleared, but at least one reply was never acked (old widget, or
 *                  the widget's POST never settled) — delivery is not proven
 * - `timeout`      the cap expired with work still pending; a result was probably dropped
 */
export type DrainResult = 'idle' | 'flushed' | 'unconfirmed' | 'timeout'

export class EventBus {
  private handlers = new Map<string, Set<Handler>>()
  private messageListener: ((e: MessageEvent) => void) | null = null

  private tools: Record<string, ToolHandler> = {}
  /** Returns false when the post could not be delivered (no live iframe) — see index.ts. */
  private postToIframe: ((msg: object) => boolean | void) | null = null
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

  /**
   * #321 — sessionIds whose tool result was posted into the widget but not yet ACKed by it.
   * The widget acks only after its `/tool-result` POST to the platform settles, so an entry
   * here means "the platform does not provably have this result yet". `destroy()` drains this
   * (and {@link inFlightTools}) before tearing the iframe down, because removing the iframe
   * kills both the postMessage target AND any POST the widget still has in flight.
   */
  private unackedReplies = new Map<number, ReturnType<typeof setTimeout>>()
  /** #321 — resolvers parked by {@link drainToolWork} until the pending sets empty. */
  private drainWaiters = new Set<() => void>()
  /** #321 — set once `destroy()` starts draining: no new tool work is accepted. */
  private closing = false
  /** #321 — a tracked reply expired on the grace timer instead of being acked (during a drain). */
  private sawUnackedDrop = false

  constructor(private allowedOrigin: string) {}

  /** Wire frontend-tool handling: the map of handlers and how to reply to the iframe. */
  configureTools(tools: Record<string, ToolHandler>, postToIframe: (msg: object) => boolean | void, timeoutMs?: number): void {
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
        // #321: the widget confirms it forwarded a tool result to the platform (posted AFTER
        // its /tool-result POST settles, so the ack means the result actually landed — not
        // merely that the postMessage arrived). Widgets older than this ack never send it;
        // the grace timer in trackReply covers that skew.
        case 'tool-result-ack':
          if (msg.sessionId != null) this.settleReply(msg.sessionId, msg.ok !== false)
          break
        // #322: the widget's POST hit a 401 TOKEN_EXPIRED and it is holding the user's message
        // until we hand it a fresh token. The widget is where expiry is DISCOVERED (it makes the
        // chat calls); the host page is the only place that can mint. index.ts answers with
        // `confiqure:token-refresh` or, if the mint is impossible/failed, `token-refresh-failed`.
        case 'token-expired':
          this.emit('token-expired')
          break
        // #238 submit channel: the widget signals it can receive the open() hand-off
        // (session open + bridge listener up — postMessage doesn't buffer), and later
        // posts the settled outcome (gates verdict / transfer failure).
        case 'submit-ready':
          this.emit('submit-ready', { conversationId: msg.conversationId })
          break
        case 'submit-result':
          this.emit('submit_result', {
            ok: msg.ok === true,
            submissionId: msg.submissionId ?? null,
            confiqureKey: msg.confiqureKey,
            itemCount: msg.itemCount ?? null,
            rejections: msg.rejections ?? [],
            error: msg.error
          })
          break
      }
    }
    window.addEventListener('message', this.messageListener)
  }

  private handleToolCall(msg: ConfiqureMessage): void {
    const sessionId = msg.sessionId
    if (sessionId == null) return
    const toolName = msg.toolName ?? ''

    /**
     * Post a tool result into the widget and, when it left the page, start tracking it as
     * unacked (#321) so `destroy()` knows there is delivery still owed. A post that finds no
     * live iframe is reported loudly by postToIframe itself and tracked as nothing — there is
     * no delivery to wait for.
     */
    const reply = (payload: object) => {
      const post = this.postToIframe
      if (!post) return
      const delivered = post({ type: 'confiqure:tool-result', sessionId, ...payload })
      if (delivered === false) return
      this.trackReply(sessionId)
    }

    // #321: `destroy()` is draining — the widget is on its way out, so don't start new handler
    // work. NACK instead of ignoring: an unanswered dispatch parks the tool session for the
    // platform's full 5-minute window, which is the exact failure class this issue is about.
    if (this.closing) {
      console.warn(`confiqure: frontend tool "${toolName}" arrived while the widget was being destroyed — replying with an error instead of running it`)
      reply({ error: 'The confiqure widget was destroyed before this tool could run' })
      return
    }

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
    const cleanup = () => {
      clearTimeout(timer)
      this.aborters.delete(aborter)
      this.inFlightTools.delete(sessionId)
      // #321: clearing the last in-flight handler may be what a destroy() drain was waiting on.
      this.checkDrained()
    }

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

    // #321 ordering matters: post the reply BEFORE cleanup(). cleanup() drops this session from
    // the in-flight set, and if that were the last pending item a concurrent destroy() drain
    // would resolve and tear the iframe down in the same tick — right before the reply is posted.
    Promise.resolve()
      .then(() => handler(msg.input, ctx))
      .then((result) => { reply({ result: result ?? null }); cleanup() })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`confiqure: frontend tool "${toolName}" failed:`, err)
        reply({ error: message })
        cleanup()
      })
  }

  /** #321 — start the ack clock for a posted tool result. */
  private trackReply(sessionId: number): void {
    const existing = this.unackedReplies.get(sessionId)
    if (existing) clearTimeout(existing)
    this.unackedReplies.set(sessionId, setTimeout(() => this.settleReply(sessionId, false), ACK_GRACE_MS))
  }

  /** #321 — stop tracking a reply. `acked=false` means the grace expired with no confirmation. */
  private settleReply(sessionId: number, acked: boolean): void {
    const timer = this.unackedReplies.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.unackedReplies.delete(sessionId)
    if (!acked) this.sawUnackedDrop = true
    this.checkDrained()
  }

  /** #321 — resolve any parked drain once no handler is running and no reply is unacked. */
  private checkDrained(): void {
    if (this.drainWaiters.size === 0) return
    if (this.hasPendingToolWork()) return
    const waiters = [...this.drainWaiters]
    this.drainWaiters.clear()
    for (const w of waiters) w()
  }

  /** #321 — is there tool work whose result has not provably reached the platform yet? */
  hasPendingToolWork(): boolean {
    return this.inFlightTools.size > 0 || this.unackedReplies.size > 0
  }

  /**
   * #321 — bounded flush, called by `destroy()`. Stops accepting new tool work, then waits
   * (at most `capMs`) for every running handler to reply and every posted reply to be acked
   * by the widget. Resolves as soon as the last item clears, so the common case where nothing
   * is in flight costs nothing.
   */
  drainToolWork(capMs: number): Promise<DrainResult> {
    this.closing = true
    if (!this.hasPendingToolWork()) return Promise.resolve<DrainResult>('idle')
    this.sawUnackedDrop = false
    return new Promise<DrainResult>((resolve) => {
      let settled = false
      let cap: ReturnType<typeof setTimeout> | undefined
      const waiter = () => {
        if (settled) return
        settled = true
        clearTimeout(cap)
        resolve(this.sawUnackedDrop ? 'unconfirmed' : 'flushed')
      }
      cap = setTimeout(() => {
        if (settled) return
        settled = true
        this.drainWaiters.delete(waiter)
        resolve('timeout')
      }, capMs)
      this.drainWaiters.add(waiter)
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
    // #321: teardown is final — drop the ack timers and release anything still parked on a drain
    // (the cap normally beats us here, but a manual stopListening() must never leak a timer).
    for (const t of this.unackedReplies.values()) clearTimeout(t)
    this.unackedReplies.clear()
    this.drainWaiters.clear()
    this.handlers.clear()
  }
}
