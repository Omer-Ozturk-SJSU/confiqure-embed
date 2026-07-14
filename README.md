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
  referentKeys: ['d20d07d7af15'],           // optional pre-selected instances
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
- `open()` without `intent`/`referentKeys`/`data` behaves exactly like `init()`;
  `chat.submission` is `null` then.
- `open()` supersedes the mint-time `openingContext` (still accepted for
  back-compat, scheduled for retirement).

### Option B: Client-side token fetch

The SDK calls your backend endpoint to get the token:

```js
const chat = await confiqure.init({
  target: '#confiqure-chat',
  tokenUrl: '/api/confiqure-token',
  endUserHandle: 'user-123',
  configEnd: 'notifications'
})
```

Your endpoint should call confiqure's `POST /api/{workspaceKey}/embed-tokens` with your API key and return `{ token: "eyJ..." }`.

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
| `configEnd` | `string` | - | Endpoint slug (with tokenUrl) |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | Color mode |
| `autoResize` | `boolean` | `false` | Auto-adjust height |
| `baseUrl` | `string` | `'https://confiqure.ai'` | Page origin serving the chat iframe |
| `apiBaseUrl` | `string` | `'https://api.confiqure.ai'` | API origin for host-page calls (frontend-tools discovery) |

## Cleanup

```js
chat.destroy()
```
