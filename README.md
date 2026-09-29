# @confiqure/embed

Drop-in JavaScript SDK for embedding [confiqure.ai](https://confiqure.ai) chat in your app.

> 📖 **Full integration reference:** [confiqure.ai/docs/embed](https://confiqure.ai/docs/embed) — the canonical, always-current spec for every token claim, SDK init option, and lifecycle event payload. This README is a quickstart; the reference is normative.

## Install

```bash
npm install @confiqure/embed
```

Or use the CDN:

```html
<script src="https://confiqure.ai/embed.js"></script>
```

## Usage

### Option A: Pre-minted token (recommended)

Your backend mints an embed token, then your frontend passes it to the SDK:

```js
import { init } from '@confiqure/embed'

const chat = await init({
  target: '#confiqure-chat',
  token: tokenFromYourBackend
})

chat.on('complete', (data) => {
  console.log('Settings saved:', data.values)
})
```

With the CDN script:

```html
<div id="confiqure-chat" style="height: 600px"></div>
<script src="https://confiqure.ai/embed.js"></script>
<script>
  confiqure.init({
    target: '#confiqure-chat',
    token: tokenFromYourBackend
  }).then(chat => {
    chat.on('complete', (data) => {
      console.log('Settings saved:', data.values)
    })
  })
</script>
```

### Opening with context + data — `confiqure.open()` (0.2.0)

When a chat open is triggered by a UI action that carries context — a "Send to
restocker" button with 500 selected items, a row's "configure this" action —
use `open()` instead of `init()`. The session opens **instantly** (token-only);
the context is then handed to the chat through the submit channel: `data` moves
as one visible transfer (a live progress block inside the chat), is validated
by your endpoint's save gates server-side, and lands in the configuration
draft. The chat model only ever sees a count-reference ("499 items — saved"),
never the payload, so large hand-offs neither stall nor destabilize the
conversation.

```js
const chat = await confiqure.open({
  target: '#confiqure-chat',
  token: tokenFromYourBackend,
  intent: 'The user clicked "Send to restocker" on the discovery panel.',
  referentKeys: ['d20d07d7af15'],           // optional — each opens that record
  toolClass: 'ListingsTool',                // optional (0.3.0) — opens the chat with this tool class loaded
  data: { restockList: [/* …the real DTO shape, real field names… */] }
})

// The hand-off's outcome — a wrong shape or oversize payload REJECTS here,
// with the gate's field-level reasons, so integration bugs surface in YOUR
// console at click time:
try {
  const result = await chat.submission
  console.log('delivered', result.confiqureKey, result.itemCount)
} catch (e) {
  console.error('submit rejected', e.result?.rejections)
}
```

Rules of the road:

- `data` is the **real DTO shape keyed by your endpoint's real field names**
  (exactly what the data API's GET returns) — no mapping, no stringifying.
- Max **10 MB** serialized; larger belongs in the attachment/document pipeline.
- Every value passes the endpoint's save-gate stack; an unknown field or
  invalid value rejects the whole submit — nothing partial is saved.
- Page-JS context carries the same trust level as the user typing into the
  chat, and is marked host-authored to the model.
- `toolClass` (0.3.0, annotation 3.0) names one of your `@Confiqure.Tool` classes —
  the chat opens with it already loaded. An unknown name is ignored, never an error.
- `open()` without `intent`/`referentKeys`/`toolClass`/`data` behaves exactly like
  `init()`; `chat.submission` is `null` then.
- `open()` supersedes the mint-time `openingContext` (still accepted for
  back-compat, scheduled for retirement).

### Browser operations (0.3.0)

A `@Confiqure.Browser` method of a tool class runs in your page. Register its handler
keyed `"ToolClassName.operationName"`:

```js
confiqure.init({
  target: '#confiqure-chat',
  token: tokenFromYourBackend,
  tools: {
    'ListingsTool.openProduct360': async (input, ctx) => { /* open the view */ return { ok: true } }
  }
})
```

### Option B: Client-side token fetch

The SDK calls your backend endpoint to get the token:

```js
const chat = await confiqure.init({
  target: '#confiqure-chat',
  tokenUrl: '/api/confiqure-token',
  endUserHandle: 'user-123'
})
```

Your endpoint should call confiqure's `POST /api/{workspaceKey}/embed-tokens` with your API key and return `{ token: "eyJ..." }`.
Since 0.3.0 (annotation 3.0) the SDK forwards only `endUserHandle` — the token names no endpoint, and the mint refuses `configEnd`.

## Events

```js
chat.on('ready', () => { })
chat.on('complete', (data) => { /* data.values */ })
chat.on('error', (err) => { /* err.code, err.message */ })
chat.on('closed', (data) => { /* data.reason */ })
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `target` | `string \| HTMLElement` | required | Mount point |
| `token` | `string` | - | Pre-minted embed JWT |
| `tokenUrl` | `string` | - | Your token endpoint |
| `endUserHandle` | `string` | - | End-user ID (with tokenUrl) |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | Color mode |
| `look` | `'phosphor' \| 'tairo' \| 'shadcn' \| 'material' \| 'bootstrap'` | the dashboard's | The chat's ready-made look (0.3.2); see below |
| `accent` | `string` | - | Your app's accent hue (0.3.1) — a hex of 3/4/6/8 digits or an `rgb()`/`hsl()` form; see below |
| `autoResize` | `boolean` | `false` | Auto-adjust height |
| `baseUrl` | `string` | `'https://confiqure.ai'` | Page origin serving the chat iframe |
| `apiBaseUrl` | `string` | `'https://api.confiqure.ai'` | API origin for host-page calls (frontend-tools discovery) |

## Following your app's theme

`theme: 'auto'` follows the visitor's operating system, not your app. If your app has its own
light/dark toggle, open the chat in your current mode and forward every flip — the chat recolours
live, with no reload:

```js
const chat = await confiqure.init({ target, token, theme: isDark() ? 'dark' : 'light' })
onYourThemeToggle((dark) => chat.setTheme(dark ? 'dark' : 'light'))   // 'light' | 'dark' | 'auto'
```

### Your accent colour — `accent` and `chat.setStyle()` (0.3.1)

Hand the chat your app's ONE accent hue: it fills the primary buttons and the send button with it,
and tints links, focus rings and the agent mark with it (blended toward the chat's own text colour
so they stay readable on either background). It keeps its own light/dark surfaces, so one hue works
in both modes; a confirmation on a card (consent, delete) keeps the chat's neutral button and a
destructive action keeps its red. Pass it at open, and change the mode, the hue, or both live with
`setStyle()`:

```js
const chat = await confiqure.open({ target, token, theme: 'light', accent: '#6b5bff' })
chat.setStyle({ theme: 'dark', accent: 'hsl(246 100% 68%)' })   // either key, or both — no reload
```

`accent` is a CSS colour string: a hex of 3, 4, 6 or 8 digits, or an `rgb()`/`hsl()` form. Anything
else (a named colour, `var(--brand)`, …) is ignored with a console warning, and the chat checks the
value again on its side with the same rule. An alpha is accepted but dropped: the chat paints your
hue opaque. An accent cannot be cleared live — to drop it, re-open the chat without one.
`setTheme(mode)` still works exactly as before; it is the same as `setStyle({ theme: mode })`.

### Ready-made looks — `look` (0.3.2)

The chat ships five looks, each a full set of surfaces, radii, shadows and input style with a day and
a night side: `phosphor` (confiqure's own, the default), `tairo`, `shadcn`, `material` and `bootstrap`
— pick the one shaped like the kit your app is built with. `theme` still picks day or night, and
your `accent` sits on top of any look:

```js
const chat = await confiqure.open({ target, token, look: 'shadcn', theme: 'light', accent: '#6b5bff' })
chat.setStyle({ look: 'material' })   // look, theme, accent — any mix, live, no reload
```

Most apps need no code for this: the look, the mode and the accent are a workspace setting in the
confiqure dashboard (Settings → chat widget look), and the chat reads it when it opens. What you pass
wins over it, for that page only — highest first: a live `setStyle()`/`setTheme()`, then the
`open()`/`init()` options, then the dashboard setting, then (for the mode) the visitor's OS. A
dashboard mode of light or dark applies when your page passes no `theme` or `'auto'`. An unknown
`look` name is ignored with a console warning.

## Cleanup

```js
chat.destroy()
```

`destroy()` returns immediately, but the actual unmount is **deferred (hard cap 2s)** while a
frontend-tool handler is still running or a posted tool result has not yet been confirmed by
the chat — otherwise a tool whose *action* is to tear the widget down (navigate, close the
modal) races and loses its own reply, and the chat stalls until that tool session expires.
Nothing in flight ⇒ teardown is instant, exactly as before. A result that still cannot be
delivered is reported with `console.error`, never dropped silently.

If you unmount by removing the container element yourself, call `destroy()` first (or return
from the handler before triggering the unmount) — the SDK cannot defer a DOM removal it does
not perform.
