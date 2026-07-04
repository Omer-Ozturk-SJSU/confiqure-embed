# @confiqure/embed

Drop-in JavaScript SDK for embedding [confiqure.ai](https://confiqure.ai) chat in your app.

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
