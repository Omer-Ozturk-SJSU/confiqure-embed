/**
 * Context passed to a frontend-tool handler. Deliberately minimal and generic —
 * no domain helpers (OAuth, pickers, etc.). The handler's job is the business
 * logic; the SDK handles all the plumbing (postMessage, timeout, threading the
 * result back into the chat).
 */
export interface ToolContext {
  /** The arguments the chat agent constructed for this call. */
  input: unknown
  /** Who the chat is for, if known. */
  endUserHandle?: string
  conversationId: number
  workspaceKey: string
  /** Report a status string back to the chat while the handler runs. */
  progress: (message: string) => void
  /** Aborted if the call times out or the widget is destroyed. */
  signal: AbortSignal
}

export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<unknown>

export interface ConfiqureInitOptions {
  target: string | HTMLElement
  token?: string
  tokenUrl?: string
  /** Only with `tokenUrl`: forwarded to your token endpoint. */
  endUserHandle?: string
  theme?: 'light' | 'dark' | 'auto'
  autoResize?: boolean
  /**
   * The confiqure PAGE origin that serves the chat iframe; default `https://confiqure.ai`.
   * NOT the API origin — passing the API origin here throws at init.
   */
  baseUrl?: string
  /**
   * The confiqure API origin used for host-page API calls (currently the frontend-tools
   * discovery fetch); default `https://api.confiqure.ai`.
   */
  apiBaseUrl?: string
  /**
   * Handlers for browser operations — the `@Confiqure.Browser` methods of your
   * `@Confiqure.Tool` classes. Keyed `"ToolClassName.operationName"` (e.g.
   * `"ListingsTool.openProduct360"`). The SDK runs the matching handler when the chat
   * calls the operation, then returns its result to the conversation. Missing handlers
   * are warned about at init.
   */
  tools?: Record<string, ToolHandler>
  /** Per-tool timeout in ms before the call is aborted and reported as an error. Default 120000. */
  toolTimeoutMs?: number
}

/**
 * #238 — `confiqure.open()` options: everything `init` takes, plus the opening context. The
 * session opens token-only and instantly; `intent`/`referentKeys`/`toolClass`/`data` are handed to the chat AFTER open through the
 * submit channel — `data` moves as one visible transfer (live progress block in the chat),
 * is validated by the endpoint's save gates, and lands in the configuration draft. The model
 * only ever sees a count-reference, never the payload.
 *
 * Trust note (by design): page-JS intent/data carries the same trust level as the user typing
 * into the chat, and it is marked host-authored to the model.
 */
export interface ConfiqureOpenOptions extends ConfiqureInitOptions {
  /** What just happened / why this chat opened — free prose, ≤ 2000 chars. */
  intent?: string
  /** Pre-selected referent instances (confiqureKeys owned by this user); ≤ 8, validated server-side. */
  referentKeys?: string[]
  /**
   * Annotation 3.0: a tool-class name (a `@Confiqure.Tool` class of your workspace) the chat
   * opens with already loaded — e.g. `'ListingsTool'` on your Listings page. An unknown name is
   * ignored by confiqure, never an error.
   */
  toolClass?: string
  /**
   * The data hand-off: the REAL DTO shape keyed by your endpoint's real field names
   * (e.g. `{ restockList: [...] }`). Max 10 MB serialized — larger belongs in the
   * attachment/document pipeline. A wrong shape rejects through {@link ConfiqureChat.submission}.
   */
  data?: Record<string, unknown>
}

/** #238 — the submit channel's result, surfaced on {@link ConfiqureChat.submission}. */
export interface SubmitResult {
  ok: boolean
  submissionId?: number | null
  /** The draft instance the data landed in (ok=true with data). */
  confiqureKey?: string
  itemCount?: number | null
  /** Gate rejections keyed by real field ids (ok=false): the deterministic wrong-shape channel. */
  rejections?: Array<{ fieldId?: string | null; reason?: string }>
  error?: string
}

export interface ConfiqureChat {
  on(event: 'ready', handler: () => void): ConfiqureChat
  on(event: 'complete', handler: (data: { confiqureKeys: string[] }) => void): ConfiqureChat
  on(event: 'error', handler: (err: { code: string; message: string }) => void): ConfiqureChat
  on(event: 'closed', handler: (data: { reason: string }) => void): ConfiqureChat
  /** #238: fires when an open() hand-off settles — same payload the `submission` promise carries. */
  on(event: 'submit_result', handler: (data: SubmitResult) => void): ConfiqureChat
  /**
   * #238: resolves when the open() hand-off (intent/data) has been delivered — rejected (with
   * the gate's reasons on the Error's `result` property) when the submit was refused, so a
   * wrong shape or an oversize payload fails loudly in YOUR console, not silently mid-chat.
   * Null when open()/init() was called without intent/referentKeys/toolClass/data.
   */
  submission: Promise<SubmitResult> | null
  /**
   * Unmount the chat and abort in-flight tool handlers.
   *
   * #321: returns immediately, but the actual teardown is DEFERRED (bounded, ≤2s) while a
   * frontend-tool handler is still running or a posted tool result has not yet been confirmed
   * by the chat — otherwise a tool whose action is to unmount the widget would race, and lose,
   * its own reply. Nothing in flight ⇒ teardown is immediate, exactly as before.
   */
  destroy(): void
  /**
   * Switch the chat's colour mode live, with no reload. Call it from your own theme toggle so
   * the widget follows YOUR app instead of the visitor's OS setting; `'auto'` hands the choice
   * back to the OS. A call made before the chat is ready is applied as soon as it is.
   * Pair it with the `theme` init option so the chat also OPENS in your current mode.
   */
  setTheme(theme: 'light' | 'dark' | 'auto'): void
}

export interface ConfiqureMessage {
  type: string
  /** Finalized instance keys carried by confiqure:complete — pull values via GET /objects/{key}. */
  confiqureKeys?: string[]
  code?: string
  message?: string
  reason?: string
  height?: number
  // confiqure:tool (iframe -> host) — a frontend tool the chat agent called.
  toolName?: string
  sessionId?: number
  input?: unknown
  conversationId?: number
  endUserHandle?: string
  workspaceKey?: string
  // #238 confiqure:submit-result (iframe -> host) — the submit channel's settled outcome.
  // #321 confiqure:tool-result-ack (iframe -> host) — reuses `sessionId` + `ok`: the widget
  // confirms it forwarded that tool result to the platform (ok=false when the POST failed).
  ok?: boolean
  // #322 confiqure:token-refresh (host -> iframe) — a freshly minted embed token, delivered
  // either proactively (before `exp`) or in answer to the widget's `confiqure:token-expired`.
  token?: string
  // confiqure:theme (host -> iframe) — chat.setTheme(): the colour mode the widget should show now.
  theme?: 'light' | 'dark' | 'auto'
  submissionId?: number | null
  confiqureKey?: string
  itemCount?: number | null
  rejections?: Array<{ fieldId?: string | null; reason?: string }>
  error?: string
}
