import type { ConfiqureProgress, ProgressVariant, ProgressState } from './types.js'

/**
 * chat.setProgress() (embed 0.4.0): the host's progress for the chat's progress strip. The widget
 * renders every string as text and never parses one; the numbers cross as numbers.
 *
 * `simpleProgressBar` is the thin bar the agent mark rides; `bulkyProgressBar` is the card with
 * the large count. The host chooses; simpleProgressBar is the default. The same two names are the
 * widget's own check (confiqure.ai: frontend/app/composables/useHostProgress.ts) — keep them in step.
 */
export const PROGRESS_VARIANTS = ['simpleProgressBar', 'bulkyProgressBar'] as const
export const PROGRESS_STATES = ['running', 'done', 'failed'] as const
/** The longest title, stage or reason the strip shows. */
export const PROGRESS_TEXT_MAX = 120

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * Validate one setProgress() value, half by half like setStyle(): a bad half is warned about and
 * dropped, the rest applies. Returns the clean progress, `null` for a clear, or `undefined` when
 * the value is not a progress at all (warned; the call does nothing).
 */
export function readProgress(value: unknown, method = 'setProgress()'): ConfiqureProgress | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    console.warn(`confiqure: ${method} expects a progress object or null — got ${JSON.stringify(value)}; ignored.`)
    return undefined
  }
  const v = value as Record<string, unknown>
  const out: ConfiqureProgress = {}
  const drop = (key: string, rule: string) =>
    console.warn(`confiqure: ${method} ${key} ${rule} — got ${JSON.stringify(v[key])}; ignored.`)
  const text = (key: 'title' | 'stage' | 'reason') => {
    if (v[key] === undefined) return
    if (typeof v[key] === 'string' && (v[key] as string).length <= PROGRESS_TEXT_MAX) out[key] = v[key] as string
    else drop(key, `must be a string of at most ${PROGRESS_TEXT_MAX} characters`)
  }
  if (v.variant !== undefined) {
    if ((PROGRESS_VARIANTS as readonly unknown[]).includes(v.variant)) out.variant = v.variant as ProgressVariant
    else drop('variant', `must be ${PROGRESS_VARIANTS.map(x => `'${x}'`).join(' or ')}`)
  }
  text('title')
  text('stage')
  for (const key of ['done', 'total'] as const) {
    if (v[key] === undefined) continue
    if (isCount(v[key])) out[key] = v[key] as number
    else drop(key, 'must be a whole number of 0 or more')
  }
  if (v.state !== undefined) {
    if ((PROGRESS_STATES as readonly unknown[]).includes(v.state)) out.state = v.state as ProgressState
    else drop('state', `must be ${PROGRESS_STATES.map(x => `'${x}'`).join(', ')}`)
  }
  text('reason')
  if (out.reason !== undefined && out.state !== 'failed') {
    console.warn(`confiqure: ${method} reason goes with state 'failed' only; ignored.`)
    delete out.reason
  }
  if (v.since !== undefined) {
    if (typeof v.since === 'number' && Number.isFinite(v.since) && v.since >= 0) out.since = v.since
    else drop('since', 'must be a time in epoch milliseconds')
  }
  return out
}

/** Two progress values are the same paint (the widget ignores a repeat; so does the SDK's re-send). */
export function sameProgress(a: ConfiqureProgress | null | undefined, b: ConfiqureProgress | null | undefined): boolean {
  if (a == null || b == null) return a === b
  const keys = ['variant', 'title', 'stage', 'done', 'total', 'state', 'reason', 'since'] as const
  return keys.every(k => a[k] === b[k])
}
