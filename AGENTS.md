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

### Evaluate JavaScript (API key required)
Execute a JavaScript expression in the page context and return the JSON-serializable result.

Parameters:
- `userId` (string) — Session owner
- `expression` (string, required) — JavaScript expression (max 64KB)
- `timeout` (number, optional) — Milliseconds (min 100, max 30000, default 5000)

Auth: required — `Authorization: Bearer $CAMOFOX_API_KEY` (server must have `CAMOFOX_API_KEY` set)

```bash
POST /tabs/:tabId/evaluate
Authorization: Bearer $CAMOFOX_API_KEY
{"userId": "agent1", "expression": "({url: window.location.href, links: document.querySelectorAll('a').length})", "timeout": 5000}
```
Returns (success): `{"ok": true, "result": {"url": "https://...", "links": 123}, "resultType": "object", "truncated": false}`

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

Additional query params:
- `scope` — CSS selector to scope link extraction
- `extension` — Comma-separated extensions to filter (e.g., ".pdf,.doc")
- `downloadOnly` — Boolean, only return download-like links

Example:
```bash
GET /tabs/:tabId/links?userId=agent1&limit=50&scope=main&extension=.pdf,.doc&downloadOnly=true
```

### List Downloads for Tab
```bash
GET /tabs/:tabId/downloads?userId=agent1
```

### List Downloads for User
```bash
GET /users/:userId/downloads
```

Example:
```bash
GET /users/agent1/downloads
```

### Get Download Metadata
```bash
GET /downloads/:downloadId?userId=agent1
```

### Get Download Content (binary stream)
```bash
GET /downloads/:downloadId/content?userId=agent1
```

Example:
```bash
curl -L "http://localhost:9377/downloads/<downloadId>/content?userId=agent1" -o downloaded.file
```

### Download Workflow for AI Agents

Every download response includes `contentUrl` — use it to fetch the file:

1. **Trigger download** (click download button, batch-download, etc.)
2. **List downloads** → each entry has `contentUrl`
3. **Fetch content** → `GET {contentUrl}` returns the binary file

Example flow:

```bash
# Step 1: Download triggered (e.g., via batch-download)
POST /tabs/:tabId/batch-download
{"userId": "agent1", "types": ["images"], "maxFiles": 10}

# Step 2: Each download in response has contentUrl
# Response: {..., "contentUrl": "/downloads/abc123/content?userId=agent1"}

# Step 3: Get the actual file
GET /downloads/abc123/content?userId=agent1
# Returns: binary file with proper Content-Type header
```

Files are stored at `~/.camofox/downloads/{userId}/` (configurable via `CAMOFOX_DOWNLOADS_DIR`).
Downloads persist for 24 hours by default (configurable via `CAMOFOX_DOWNLOAD_TTL_MS`).

### Delete Download
```bash
DELETE /downloads/:downloadId
{"userId": "agent1"}
```

### Extract Resources
Extract resources from the current page DOM (optionally scoped to a container).

```bash
POST /tabs/:tabId/extract-resources
{"userId": "agent1", "selector": "div.post", "types": ["images", "links"], "extensions": [".jpg", ".png"], "resolveBlobs": true, "triggerLazyLoad": true}
```

### Batch Download
Extract resources and download them in one request.

```bash
POST /tabs/:tabId/batch-download
{"userId": "agent1", "selector": "div.post", "types": ["images"], "maxFiles": 50}
```

### Resolve Blob URLs
Resolve `blob:` URLs into `data:` URIs.

```bash
POST /tabs/:tabId/resolve-blobs
{"userId": "agent1", "urls": ["blob:https://example.com/abc123"]}
```

### YouTube Transcript
```bash
POST /youtube/transcript
{"url": "https://youtube.com/watch?v=dQw4w9WgXcQ", "languages": ["en"]}
```
Returns: `{"status": "ok", "transcript": "[00:00] Hello...", "video_id": "...", "video_title": "...", "language": "en", "total_words": 123}`

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
docker run -d -p 9377:9377 -v ~/.camofox:/home/node/.camofox camofox-browser
```

## Key Files

- `server.js` - Camoufox engine
- `Dockerfile` - Production container
