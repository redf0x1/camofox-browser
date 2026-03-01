# camofox-browser Agent Guide

Headless browser automation server for AI agents. Run locally or deploy to any cloud provider.

## Quick Start for Agents

```bash
# Install and start
npm install && npm start
# Server runs on http://localhost:9377
```

## Core Workflow

1. **Create a tab** → Get `tabId`
2. **Navigate** → Go to URL or use search macro
3. **Get snapshot** → Receive page content with element refs (`e1`, `e2`, etc.)
4. **Interact** → Click/type using refs
5. **Repeat** steps 3-4 as needed

## API Reference

### Create Tab
```bash
POST /tabs
{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}
```
Returns: `{"tabId": "abc123", "url": "...", "title": "..."}`

### Navigate
```bash
POST /tabs/:tabId/navigate
{"userId": "agent1", "url": "https://google.com"}
# Or use macro:
{"userId": "agent1", "macro": "@google_search", "query": "weather today"}
```

### Get Snapshot
```bash
GET /tabs/:tabId/snapshot?userId=agent1
```
Returns accessibility tree with refs:
```
[heading] Example Domain
[paragraph] This domain is for use in examples.
[link e1] More information...
```

### Click Element
```bash
POST /tabs/:tabId/click
{"userId": "agent1", "ref": "e1"}
# Or CSS selector:
{"userId": "agent1", "selector": "button.submit"}
```

### Type Text
```bash
POST /tabs/:tabId/type
{"userId": "agent1", "ref": "e2", "text": "hello world"}
# Add enter: {"userId": "agent1", "ref": "e2", "text": "search query", "pressEnter": true}
```

### Scroll
```bash
POST /tabs/:tabId/scroll
{"userId": "agent1", "direction": "down", "amount": 500}
```

### Scroll Element
Scroll a specific scrollable container (modals, sidebars, overflow divs) by `ref` from snapshot or a CSS `selector`.

Parameters:
- `userId` (string) — Session owner
- `ref` (string, optional) — Element ref like `e12` (from `/snapshot`)
- `selector` (string, optional) — CSS selector (use `"html"` for page-level scrolling)
- `deltaY` (number, optional) — Vertical delta (default: `300` if no `scrollTo`)
- `deltaX` (number, optional) — Horizontal delta (default: `0`)
- `scrollTo` (object, optional) — Absolute position: `{ "top"?: number, "left"?: number }`

Auth: none

```bash
POST /tabs/:tabId/scroll-element
{"userId": "agent1", "selector": "div.modal-body", "deltaY": 400}
# Or absolute positioning:
{"userId": "agent1", "ref": "e12", "scrollTo": {"top": 0}}
```
Returns: `{"ok": true, "scrollPosition": {"scrollTop": 400, "scrollLeft": 0, "scrollHeight": 1200, "clientHeight": 600, "scrollWidth": 800, "clientWidth": 800}}`

### Evaluate JavaScript (conditional API key auth)
Execute a JavaScript expression in the page context and return the JSON-serializable result.

Parameters:
- `userId` (string) — Session owner
- `expression` (string, required) — JavaScript expression (max 64KB)
- `timeout` (number, optional) — Milliseconds (min 100, max 30000, default 5000)

Auth: required only when `CAMOFOX_API_KEY` is set on the server; otherwise no auth is required

Note: async expressions must be wrapped in an async IIFE (for example, `(async () => { ... })()`). Top-level `await` is not supported.

```bash
POST /tabs/:tabId/evaluate
Authorization: Bearer $CAMOFOX_API_KEY
{"userId": "agent1", "expression": "({url: window.location.href, links: document.querySelectorAll('a').length})", "timeout": 5000}
```
Returns (success): `{"ok": true, "result": {"url": "https://...", "links": 123}, "resultType": "object", "truncated": false}`

Returns (error): `{"ok": false, "error": "...", "errorType": "js_error" | "timeout"}`

### Evaluate JavaScript (Extended)
Execute a long-running JavaScript expression (up to 300s timeout). Conditionally API-key protected. Rate limited.

Parameters:
- `userId` (string) — Session owner
- `expression` (string, required) — JavaScript expression (max 64KB)
- `timeout` (number, optional) — Milliseconds (min 100, max 300000, default 30000)

Auth: required only when `CAMOFOX_API_KEY` is set on the server; otherwise no auth is required

Note: async expressions must be wrapped in an async IIFE (for example, `(async () => { ... })()`). Top-level `await` is not supported.

Rate limit: 20 requests per minute per userId (configurable)

```bash
POST /tabs/:tabId/evaluate-extended
Authorization: Bearer $CAMOFOX_API_KEY
{"userId": "agent1", "expression": "(async () => { const response = await fetch('/api/data'); return await response.json(); })()", "timeout": 120000}
```
Returns (success): `{"ok": true, "result": "done", "resultType": "string", "truncated": false}`

Returns (error): `{"ok": false, "error": "...", "errorType": "js_error" | "timeout"}`

### Navigation
```bash
POST /tabs/:tabId/back     {"userId": "agent1"}
POST /tabs/:tabId/forward  {"userId": "agent1"}
POST /tabs/:tabId/refresh  {"userId": "agent1"}
```

### Get Links
```bash
GET /tabs/:tabId/links?userId=agent1&limit=50
```

### Close Tab
```bash
DELETE /tabs/:tabId?userId=agent1
```

## Search Macros

Use these instead of constructing URLs:

| Macro | Site |
|-------|------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@linkedin_search` | LinkedIn |

## Element Refs

Refs like `e1`, `e2` are stable identifiers for page elements:

1. Call `/snapshot` to get current refs
2. Use ref in `/click` or `/type`
3. Refs reset on navigation - get new snapshot after

## Session Management

- `userId` isolates cookies/storage between users
- `sessionKey` groups tabs by conversation/task (legacy: `listItemId` also accepted)
- Sessions timeout after 30 minutes of inactivity
- Delete all user data: `DELETE /sessions/:userId`

## Running Engines

### Camoufox (Default)
```bash
npm start
# Or: ./run.sh
```
Firefox-based with anti-detection. Bypasses Google captcha.

## Testing

```bash
npm test              # E2E tests
npm run test:live     # Live Google tests
npm run test:debug    # With server output
```

## Docker

```bash
docker build -t camofox-browser .
docker run -p 9377:9377 camofox-browser
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMOFOX_HEADLESS` | `true` | Display mode: `true` (headless), `false` (headed), `virtual` (Xvfb) |
| `CAMOFOX_VNC_RESOLUTION` | `1920x1080x24` | Virtual Xvfb display resolution (`WIDTHxHEIGHTxDEPTH`) |
| `CAMOFOX_VNC_TIMEOUT_MS` | `120000` | Max VNC session duration in ms before auto-stop |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX` | `20` | Max evaluate-extended requests per user per window |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window duration in ms |

## Key Files

- `server.js` - Camoufox engine
- `Dockerfile` - Production container
