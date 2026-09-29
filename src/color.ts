/**
 * The ONE rule for a host accent colour (`open({ accent })`, `chat.setStyle({ accent })`).
 *
 * Accepted: a hex colour of 3, 4, 6 or 8 digits (`#6b5bff`, `#6b5bff80`), or an `rgb()`/`rgba()`/
 * `hsl()`/`hsla()` form with plain numeric channels — the comma form (`rgb(107, 91, 255)`,
 * `hsl(246, 100%, 68%)`) or the space form (`rgb(107 91 255 / 80%)`). Anything else — a named
 * colour, `var()`, `color-mix()`, a gradient, a stray `;` — is refused, so a value that passes
 * can only ever be a colour. At most 64 characters.
 *
 * The chat widget re-checks every value it receives with the IDENTICAL rule
 * (confiqure.ai: frontend/app/utils/widgetTheme.ts, `isCssColor`) — keep the two in step.
 */
const N = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)'   // an unsigned number: 12, 12.5, .5
const P = `${N}%`                           // a percentage
const A = `${N}%?`                          // an alpha: number or percentage
const H = `-?${N}(?:deg|grad|rad|turn)?`    // a hue angle
const CSS_COLOR = new RegExp('^(?:' + [
  '#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})',
  `rgba?\\(\\s*${N}\\s*,\\s*${N}\\s*,\\s*${N}\\s*(?:,\\s*${A}\\s*)?\\)`,
  `rgba?\\(\\s*${P}\\s*,\\s*${P}\\s*,\\s*${P}\\s*(?:,\\s*${A}\\s*)?\\)`,
  `rgba?\\(\\s*${N}%?\\s+${N}%?\\s+${N}%?\\s*(?:\\/\\s*${A}\\s*)?\\)`,
  `hsla?\\(\\s*${H}\\s*,\\s*${P}\\s*,\\s*${P}\\s*(?:,\\s*${A}\\s*)?\\)`,
  `hsla?\\(\\s*${H}\\s+${P}\\s+${P}\\s*(?:\\/\\s*${A}\\s*)?\\)`
].join('|') + ')$', 'i')

export function isCssColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && CSS_COLOR.test(v)
}
