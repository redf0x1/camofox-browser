# CamoFox Browser Server

> Anti-detection browser server for AI agents — TypeScript REST API wrapping the [Camoufox](https://github.com/daijro/camoufox) stealth browser engine

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)
[![Node](https://img.shields.io/badge/Node-18%2B-green)](package.json)

## Table of Contents

- [Why CamoFox?](#why-camofox)
- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Search Macros](#search-macros)
- [Geo Presets](#geo-presets)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Used With](#used-with)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Why CamoFox?

**The Problem**: Standard browser automation (Puppeteer, Playwright, Selenium) is easily detected by modern anti-bot systems. JavaScript-level patches are fragile and get bypassed quickly.

**The Solution**: CamoFox Browser Server wraps [Camoufox](https://github.com/daijro/camoufox), a Firefox fork with **C++ engine-level fingerprint spoofing**. No JavaScript injection — anti-detection happens at the browser engine level.

| Feature | Puppeteer/Playwright | CamoFox Browser Server |
|---------|---------------------|------------------------|
| Anti-detection | JavaScript patches (fragile) | C++ engine-level (robust) |
| Fingerprint spoofing | Limited | Full (engine-level) |
| Token efficiency | Raw HTML / screenshots | Accessibility snapshots (smaller + structured) |
| Integration | Direct SDK | REST API for any language / AI agent |
| AI agent support | Varies | MCP + OpenClaw compatible |

## Features

- **C++ Anti-Detection** — fingerprint spoofing at the Camoufox engine level (not JS injection)
- **REST API** — language-agnostic HTTP endpoints for browser automation and AI agent integration
- **Multi-Session** — concurrent isolated browser contexts per `userId` (defaults: max 50 sessions, max 10 tabs/session)
- **Persistent Browser Profiles** — Each user gets a dedicated Firefox profile. Cookies, localStorage, IndexedDB, and all browser storage persist across sessions automatically.
- **Geo Presets** — 8 built-in region presets (locale/timezone/geolocation) + custom presets file
- **14 Search Macros** — Google, YouTube, Amazon, Reddit (search + subreddit JSON), Wikipedia, Twitter, Yelp, Spotify, Netflix, LinkedIn, Instagram, TikTok, Twitch
- **Element Refs** — accessibility snapshots annotated with stable `eN` element references for precise interaction
- **Cookie Persistence** — import Netscape/Playwright-style cookies into a session (optional, gated by API key)
- **OpenClaw Plugin** — OpenClaw-compatible endpoints (`/start`, `/tabs/open`, `/act`, etc.)
- **TypeScript** — strict mode, typed request shapes, modular Express routes
- **YouTube Transcript Extraction** — yt-dlp primary pipeline with browser fallback
- **Snapshot Pagination** — offset-based windowing for large page snapshots
- **Browser Health Monitoring** — health probe with recovery/degraded state tracking

## Quick Start

### From Source

```bash
git clone https://github.com/redf0x1/camofox-browser.git
cd camofox-browser
npm install
npm run build
npm start
```

### Using npm (CLI)

This is a **server**, not a browser automation library. Most users should run it from source or Docker.

If you want a minimal CLI wrapper that starts the server (via the package `bin`):

```bash
npm install -g camofox-browser
camofox-browser
```

Or one-off:

```bash
npx camofox-browser
```

### Using Docker

```bash
docker build -t camofox-browser .
docker run -d \
  --name camofox-browser \
  -p 9377:9377 \
  -p 6080:6080 \
  -v ~/.camofox:/home/node/.camofox \
  camofox-browser
```

To persist browser profiles (cookies, localStorage, IndexedDB, etc.) across container restarts:

```bash
docker run -d \
  --name camofox-browser \
  -p 9377:9377 \
  -p 6080:6080 \
  -v ~/.camofox:/home/node/.camofox \
  camofox-browser
```

The volume mount `-v ~/.camofox:/home/node/.camofox` ensures profiles persist across container restarts.

### Using Docker Compose

```yaml
services:
  camofox-browser:
    build: .
    ports:
      - "9377:9377"
    environment:
      CAMOFOX_PORT: "9377"
      # Optional auth gates
      # CAMOFOX_API_KEY: "change-me"
      # CAMOFOX_ADMIN_KEY: "change-me"
      # Optional: proxy routing (also enables Camoufox geoip mode)
      # PROXY_HOST: ""
      # PROXY_PORT: ""
      # PROXY_USERNAME: ""
      # PROXY_PASSWORD: ""
```

### Verify

```bash
curl http://localhost:9377/health
# {"ok":true,"engine":"camoufox","browserConnected":true}
```

## Architecture

```
AI Agent (MCP / OpenClaw / REST Client)
    │
    ▼ HTTP REST API (port 9377)
┌──────────────────────────────────────────┐
│          CamoFox Browser Server          │
│          (Express + TypeScript)          │
├──────────────────────────────────────────┤
│ Routes                 Services          │
│  ├── Core API           ├── Browser      │
│  └── OpenClaw compat    ├── Session      │
│                         └── Tab ops      │
├──────────────────────────────────────────┤
│        Camoufox Engine (anti-detect)     │
│   Firefox fork + engine-level spoofing   │
└──────────────────────────────────────────┘
```

### Persistent Profiles (v1.3.0)

- Each `userId` runs in its own persistent Firefox process/context (backed by `launchPersistentContext(userDataDir)`)
- Profile data is stored at `~/.camofox/profiles/{userId}/` (override via `CAMOFOX_PROFILES_DIR`)
- Idle user contexts are closed via LRU eviction (profile data remains on disk)

## API Reference

Base URL: `http://localhost:9377`

### Core Endpoints

Note: For any endpoint that targets an existing tab (`/tabs/:tabId/...`), the server resolves `tabId` **within a `userId` scope**. If you omit `userId`, you will typically get `404 Tab not found`.

| Method | Endpoint | Description | Required | Auth |
|--------|----------|-------------|----------|------|
| POST | `/sessions/:userId/cookies` | Import cookies into a user session (Playwright cookie objects) | Path: `userId`; Body: `{ "cookies": Cookie[] }` | `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/health` | Health check (also pre-launches the browser) | None | None |
| GET | `/presets` | List available geo presets (built-in + custom) | None | None |
| POST | `/tabs` | Create a new tab (supports `preset` + per-field overrides) | Body: `userId` + (`sessionKey` or `listItemId`) | None |
| GET | `/tabs?userId=...` | List all tabs for a user (OpenClaw-compatible response shape) | Query: `userId` | None |
| POST | `/tabs/:tabId/navigate` | Navigate to a URL, or expand a search `macro` + `query` | Body: `userId` + (`url` or `macro`) | None |
| GET | `/tabs/:tabId/snapshot?userId=...` | Accessibility snapshot annotated with `eN` element refs | Query: `userId` | None |
| POST | `/tabs/:tabId/wait` | Wait for page readiness (DOM + optional network idle) | Body: `userId` | None |
| POST | `/tabs/:tabId/click` | Click by `ref` (e.g. `e12`) or CSS `selector` | Body: `userId` + (`ref` or `selector`) | None |
| POST | `/tabs/:tabId/type` | Type into an element by `ref` or CSS `selector` | Body: `userId` + (`ref` or `selector`) + `text` | None |
| POST | `/tabs/:tabId/press` | Press a key (e.g. `Enter`, `Escape`) | Body: `userId` + `key` | None |
| POST | `/tabs/:tabId/scroll` | Scroll up/down by pixels | Body: `userId` | None |
| POST | `/tabs/:tabId/back` | Go back | Body: `userId` | None |
| POST | `/tabs/:tabId/forward` | Go forward | Body: `userId` | None |
| POST | `/tabs/:tabId/refresh` | Refresh | Body: `userId` | None |
| GET | `/tabs/:tabId/links?userId=...&limit=50&offset=0` | Extract links (paginated) | Query: `userId` | None |
| GET | `/tabs/:tabId/screenshot?userId=...&fullPage=true` | Screenshot (PNG bytes) | Query: `userId` | None |
| GET | `/tabs/:tabId/stats?userId=...` | Tab stats + visited URLs | Query: `userId` | None |
| DELETE | `/tabs/:tabId` | Close a tab (expects JSON body: `{ "userId": "..." }`) | Body: `userId` | None |
| DELETE | `/tabs/group/:listItemId` | Close a tab group (expects JSON body: `{ "userId": "..." }`) | Body: `userId` | None |
| DELETE | `/sessions/:userId` | Close all sessions for a user | Path: `userId` | None |

### Toggle Display Mode
```bash
POST /sessions/:userId/toggle-display
{"headless": "virtual"}
```
Switch browser between headless and headed mode. When encountering CAPTCHAs or issues requiring visual interaction, switch to headed mode to show the browser window.

Returns:
```json
{"ok": true, "headless": "virtual", "vncUrl": "http://localhost:6080/vnc.html?autoconnect=true&resize=scale&token=...", "message": "Browser visible via VNC", "userId": "agent1"}
```

**Note:** This restarts the browser context. All tabs are invalidated but cookies/auth state persist via the persistent profile.

### Browser Viewer (noVNC)
When the display mode is set to `"virtual"` or `false`, the server automatically starts a VNC viewer accessible via web browser.

```bash
# 1. Switch to virtual mode
POST /sessions/:userId/toggle-display
{"headless": "virtual"}
# Response includes vncUrl — open in browser to see Firefox

# 2. Solve CAPTCHA or interact with the browser

# 3. Switch back to headless
POST /sessions/:userId/toggle-display
{"headless": true}
# VNC automatically stops
```

The VNC session auto-terminates after 2 minutes (configurable via `CAMOFOX_VNC_TIMEOUT_MS`).

| Endpoint | Description | Required |
|----------|-------------|----------|
| `POST /youtube/transcript` | Extract transcript from YouTube video | `url`, `languages?` |

### OpenClaw Endpoints

OpenClaw-compatible aliases (used by the OpenClaw plugin).

| Method | Endpoint | Description | Required | Auth |
|--------|----------|-------------|----------|------|
| GET | `/` | Status (alias of `/health`) | None | None |
| POST | `/tabs/open` | Open tab (OpenClaw request/response shape) | Body: `userId` + `url` | None |
| POST | `/start` | Start browser engine | None | None |
| POST | `/stop` | Stop browser engine | None | `x-admin-key: $CAMOFOX_ADMIN_KEY` |
| POST | `/navigate` | Navigate (OpenClaw request shape: `targetId` in body) | Body: `userId` + `targetId` + `url` | None |
| GET | `/snapshot?userId=...&targetId=...` | Snapshot (OpenClaw response shape) | Query: `userId` + `targetId` | None |
| POST | `/act` | Combined actions (`click`, `type`, `press`, `scroll`, `scrollIntoView`, `hover`, `wait`, `close`) | Body: `userId` + `targetId` + `kind` | None |

## Search Macros

Use macros via `POST /tabs/:tabId/navigate` with `{ "macro": "@google_search", "query": "..." }`.

| Macro | Engine |
|-------|--------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit (JSON) |
| `@reddit_subreddit` | Reddit subreddit (JSON) |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@spotify_search` | Spotify |
| `@netflix_search` | Netflix |
| `@linkedin_search` | LinkedIn |
| `@instagram_search` | Instagram tags |
| `@tiktok_search` | TikTok |
| `@twitch_search` | Twitch |

## Geo Presets

Built-in presets (also exposed via `GET /presets`):

| Preset | Locale | Timezone | Location |
|--------|--------|----------|----------|
| `us-east` | `en-US` | `America/New_York` | New York (40.7128, -74.0060) |
| `us-west` | `en-US` | `America/Los_Angeles` | Los Angeles (34.0522, -118.2437) |
| `japan` | `ja-JP` | `Asia/Tokyo` | Tokyo (35.6895, 139.6917) |
| `uk` | `en-GB` | `Europe/London` | London (51.5074, -0.1278) |
| `germany` | `de-DE` | `Europe/Berlin` | Berlin (52.5200, 13.4050) |
| `vietnam` | `vi-VN` | `Asia/Ho_Chi_Minh` | Ho Chi Minh City (10.8231, 106.6297) |
| `singapore` | `en-SG` | `Asia/Singapore` | Singapore (1.3521, 103.8198) |
| `australia` | `en-AU` | `Australia/Sydney` | Sydney (-33.8688, 151.2093) |

Create a tab with a preset:

```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","sessionKey":"task1","preset":"japan","url":"https://example.com"}'
```

Custom presets: set `CAMOFOX_PRESETS_FILE=/path/to/presets.json` (JSON object; keys become preset names).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMOFOX_PORT` | `9377` | Server port |
| `PORT` | (optional) | Alternative port env var (common in PaaS) |
| `NODE_ENV` | `development` | Node environment |
| `CAMOFOX_ADMIN_KEY` | (empty) | Required for `POST /stop` (sent via `x-admin-key`) |
| `CAMOFOX_API_KEY` | (empty) | Enables cookie import endpoint; sent via `Authorization: Bearer ...` |
| `CAMOFOX_HEADLESS` | `true` | Display mode: `true` (headless), `false` (headed), `virtual` (Xvfb) |
| `CAMOFOX_VNC_RESOLUTION` | `1920x1080x24` | Virtual Xvfb display resolution (`WIDTHxHEIGHTxDEPTH`) |
| `CAMOFOX_VNC_TIMEOUT_MS` | `120000` | Max VNC session duration in ms before auto-stop |
| `CAMOFOX_COOKIES_DIR` | `~/.camofox/cookies` | Directory used by the OpenClaw plugin cookie tool |
| `CAMOFOX_PROFILES_DIR` | `~/.camofox/profiles` | Profile storage directory (persistent per-user Firefox profiles) |
| `CAMOFOX_PRESETS_FILE` | (unset) | Optional JSON file defining/overriding geo presets |
| `CAMOFOX_SESSION_TIMEOUT` | `1800000` | Session idle timeout in ms (min `60000`) |
| `CAMOFOX_MAX_SESSIONS` | `50` | Maximum concurrent sessions |
| `CAMOFOX_MAX_TABS` | `10` | Maximum tabs per session |
| `PROXY_HOST` | (empty) | Proxy host (enables proxy routing) |
| `PROXY_PORT` | (empty) | Proxy port |
| `PROXY_USERNAME` | (empty) | Proxy username |
| `PROXY_PASSWORD` | (empty) | Proxy password |
| `CAMOFOX_MAX_SNAPSHOT_CHARS` | `80000` | Max characters in snapshot before truncation |
| `CAMOFOX_SNAPSHOT_TAIL_CHARS` | `5000` | Characters preserved at end of truncated snapshot |
| `CAMOFOX_BUILDREFS_TIMEOUT_MS` | `12000` | Timeout for building element refs |
| `CAMOFOX_TAB_LOCK_TIMEOUT_MS` | `30000` | Timeout for acquiring tab lock |
| `CAMOFOX_HEALTH_PROBE_INTERVAL_MS` | `60000` | Health probe check interval |
| `CAMOFOX_FAILURE_THRESHOLD` | `3` | Consecutive failures before health degradation |
| `CAMOFOX_YT_DLP_TIMEOUT_MS` | `30000` | Timeout for yt-dlp subtitle extraction |
| `CAMOFOX_YT_BROWSER_TIMEOUT_MS` | `25000` | Timeout for browser transcript fallback |

## Deployment

### Docker (Recommended)

```bash
docker build -t camofox-browser .
docker run -p 9377:9377 -p 6080:6080 \
  -v ~/.camofox:/home/node/.camofox \
  -e CAMOFOX_PORT=9377 \
  camofox-browser
```

### Fly.io

This repo includes a starter `fly.toml` for one-command deploys.

```bash
fly launch
fly deploy
```

### Railway

- Create a new project → deploy from this GitHub repo
- Set `CAMOFOX_PORT=9377` (Railway will also provide `PORT`, which is supported)
- Ensure the service exposes port `9377`

### Render

- Create a new Web Service → deploy from this GitHub repo
- Use Docker (recommended) and expose port `9377`
- Set `CAMOFOX_PORT=9377` (or rely on Render `PORT`)

### System Requirements

- Node.js 18+ (20+ recommended)
- 2GB+ RAM (browser + contexts require significant memory)
- Linux recommended for production; macOS is fine for development

## Used With

| Project | Description |
|---------|-------------|
| [CamoFox MCP](https://github.com/redf0x1/camofox-mcp) | MCP (Model Context Protocol) server for Claude, Cursor, VS Code |
| [OpenClaw](https://openclaw.ai) | Open-source AI agent framework (compat endpoints included) |
| [Camoufox](https://github.com/daijro/camoufox) | Anti-detection Firefox browser engine |

## Project Structure

```text
src/
├── server.ts           # Express app entry point
├── types.ts            # Shared TypeScript interfaces
├── routes/
│   ├── core.ts         # Core REST API (~21 endpoints)
│   └── openclaw.ts     # OpenClaw compatibility (~7 endpoints)
├── services/
│   ├── browser.ts      # Browser lifecycle + persistent context pool
│   ├── health.ts       # Browser health tracking
│   ├── session.ts      # Session management + limits
│   ├── tab.ts          # Tab operations (snapshot/click/type/etc.)
│   └── youtube.ts      # YouTube transcript extraction
├── middleware/         # Auth, logging, errors
└── utils/
  ├── config.ts       # Environment config parsing
  ├── macros.ts       # Search macro expansion
  ├── presets.ts      # Geo preset definitions/loader
  └── snapshot.ts     # Snapshot truncation/windowing
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## Credits

This project is based on [camofox-browser](https://github.com/jo-inc/camofox-browser) by [Jo Inc](https://github.com/jo-inc) (YC W24) and the [Camoufox](https://github.com/daijro/camoufox) anti-detection browser engine by [daijro](https://github.com/daijro).

- [Camoufox](https://camoufox.com) - Firefox-based browser with C++ anti-detection
- [Donate to Camoufox's original creator daijro](https://camoufox.com/about/)
- [OpenClaw](https://openclaw.ai) - Open-source AI agent framework

## License

[MIT](LICENSE)

## Crypto Scam Warning

Sketchy people are doing sketchy things with crypto tokens named "Camofox" now that this project is getting attention. **Camofox is not a crypto project and will never be one.** Any token, coin, or NFT using the Camofox name has nothing to do with us.

