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
  endUserHandle?: string
  configEnd?: string
  theme?: 'light' | 'dark' | 'auto'
  autoResize?: boolean
  baseUrl?: string
  /**
   * Handlers for frontend tools (declared `serverSide=false` in the host's
   * `@Confiqure.Tool` methods). Keyed by tool name. The SDK runs the matching
   * handler when the chat agent calls the tool, then returns its result to the
   * conversation. Missing handlers are warned about at init.
   */
  tools?: Record<string, ToolHandler>
  /** Per-tool timeout in ms before the call is aborted and reported as an error. Default 120000. */
  toolTimeoutMs?: number
}

export interface ConfiqureChat {
  on(event: 'ready', handler: () => void): ConfiqureChat
  on(event: 'complete', handler: (data: { confiqureKeys: string[] }) => void): ConfiqureChat
  on(event: 'error', handler: (err: { code: string; message: string }) => void): ConfiqureChat
  on(event: 'closed', handler: (data: { reason: string }) => void): ConfiqureChat
  destroy(): void
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
}
