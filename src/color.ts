/**
 * The ONE rule for a host accent colour (`open({ accent })`, `chat.setStyle({ accent })`).
 *
 * Accepted: a hex colour of 3, 4, 6 or 8 digits (`#6b5bff`, `#6b5bff80`), or an `rgb()`/`rgba()`/
 * `hsl()`/`hsla()` form with plain numeric channels — the comma form (`rgb(107, 91, 255)`,
 * `hsl(246, 100%, 68%)`) or the space form (`rgb(107 91 255 / 80%)`). Anything else — a named
 * colour, `var()`, `color-mix()`, a gradient, a stray `;` — is refused. The gaps between channels
 * are CSS whitespace only (space, tab, newline, CR, form feed): `\s` would also let through NBSP,
 * VT, U+2028, BOM, U+3000 and U+1680, which CSS does not parse — such a "colour" blanks every
 * fill that reads it. At most 64 characters. An alpha is accepted, but the chat paints the hue
 * opaque (it drops the alpha), so a translucent value can never hide a button.
 *
 * The chat widget re-checks every value it receives with the IDENTICAL rule
 * (confiqure.ai: frontend/app/utils/widgetTheme.ts, `isCssColor`) — keep the two in step.
 */
const N = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)'   // an unsigned number: 12, 12.5, .5
const P = `${N}%`                           // a percentage
const A = `${N}%?`                          // an alpha: number or percentage
const H = `-?${N}(?:deg|grad|rad|turn)?`    // a hue angle
const W = '[ \\t\\n\\r\\f]'                  // CSS whitespace — never \s (see above)
const CSS_COLOR = new RegExp('^(?:' + [
  '#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})',
  `rgba?\\(${W}*${N}${W}*,${W}*${N}${W}*,${W}*${N}${W}*(?:,${W}*${A}${W}*)?\\)`,
  `rgba?\\(${W}*${P}${W}*,${W}*${P}${W}*,${W}*${P}${W}*(?:,${W}*${A}${W}*)?\\)`,
  `rgba?\\(${W}*${N}%?${W}+${N}%?${W}+${N}%?${W}*(?:\\/${W}*${A}${W}*)?\\)`,
  `hsla?\\(${W}*${H}${W}*,${W}*${P}${W}*,${W}*${P}${W}*(?:,${W}*${A}${W}*)?\\)`,
  `hsla?\\(${W}*${H}${W}+${P}${W}+${P}${W}*(?:\\/${W}*${A}${W}*)?\\)`
].join('|') + ')$', 'i')

export function isCssColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && CSS_COLOR.test(v)
}
