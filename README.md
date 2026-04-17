# CamoFox Browser Server

> Anti-detection browser server for AI agents — TypeScript REST API wrapping the [Camoufox](https://github.com/daijro/camoufox) stealth browser engine

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)
[![Node](https://img.shields.io/badge/Node-20%2B-green)](package.json)
[![npm](https://img.shields.io/npm/v/camofox-browser)](https://www.npmjs.com/package/camofox-browser)

## Table of Contents

- [Why CamoFox?](#why-camofox)
- [Features](#features)
- [Preview Status](#preview-status)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Console Capture](#console-capture)
- [Playwright Tracing](#playwright-tracing)
- [Security](#security)
- [Usage with AI Agents](#usage-with-ai-agents)
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
- **Cookie Persistence** — import Netscape/Playwright-style cookies into a session (bearer auth required only when `CAMOFOX_API_KEY` is set)
- **OpenClaw Plugin** — OpenClaw-compatible endpoints (`/start`, `/tabs/open`, `/act`, etc.)
- **TypeScript** — strict mode, typed request shapes, modular Express routes
- **YouTube Transcript Extraction** — yt-dlp + browser fallback (service-level; no public API route currently exposed)
- **Snapshot Pagination** — offset-based windowing for large page snapshots
- **Browser Health Monitoring** — health probe with recovery/degraded state tracking
- 🖥️ **CLI Mode** — 50+ commands for terminal-based browser automation
- 🔐 **Auth Vault** — AES-256-GCM encrypted credential storage (LLM-safe)
- 📜 **Pipeline Scripting** — Execute command scripts from files
- 🔍 **Console Capture** — capture and filter browser console messages and uncaught errors
- 📼 **Playwright Tracing** — record and export Playwright traces for debugging

## Preview Status

CamoFox Browser Server is in **Preview** (Phase 1). Preview releases are functional for browser automation and agent integration, but carry specific compatibility commitments and explicit non-goals.

### What Preview Means
- The REST API and CLI are usable for agent workflows today; [CamoFox MCP](https://github.com/redf0x1/camofox-mcp) is available as an external companion integration
- New features may be added between minor versions
- Backward-compatible aliases are maintained for renamed or moved endpoints (see [Compatibility Policy](#compatibility-policy))
- Local state (profiles, registries, sessions) uses versioned formats with fail-closed integrity checks

### What Preview Does NOT Guarantee
- **Frozen API surface** — endpoint behavior, request shapes, or response formats may change between minor versions
- **Automatic local-state migration** — browser profiles, download registries, and session files use versioned sidecar formats; incompatible upgrades require manual reset (see [Local State Recovery](#local-state-recovery))
- **Downgrade safety** — rolling back to an older version may require clearing local state
- **Fixed GA timeline** — promotion to GA requires meeting evidence-based exit criteria, not a calendar date

### Compatibility Policy
During Preview, CamoFox follows an **additive-only deprecation model**:
- **Legacy aliases** (e.g., `listItemId` accepted alongside `sessionKey`, OpenClaw `/act` routing to core endpoints) continue to work alongside their replacements
- **Deprecated fields** are accepted silently; no removal until GA or a documented migration window with advance notice in CHANGELOG
- **No existing endpoint** is removed in a minor version — removals happen only in major versions with prior CHANGELOG notice

### Local State Recovery
Browser profiles, download registries, and CLI session files use versioned sidecar formats. When upgrading CamoFox:
- **Compatible versions**: State loads normally
- **Incompatible or corrupt state**: The server refuses to load incompatible profiles and download registries; the CLI rejects incompatible saved-session files. Both log an actionable error with the specific recovery path.
- **Recovery**: Delete the affected profile directory, session file, or download registry as indicated in the error message. Clean state is recreated on next use.

Supported sidecars include limited forward-migration paths (e.g., fingerprint v0 → v1); when no migration path exists for a given version, the server refuses to load the file and logs an actionable recovery message. There is no silent repair or downgrade path — this fail-closed default prevents data corruption at the cost of manual intervention on unsupported version jumps.

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

```bash
npm install -g camofox-browser

# Start the server
camofox-browser

# Or use the CLI for browser automation
camofox open https://example.com
camofox snapshot
camofox click e5
```

> See [CLI](#cli) for the complete command reference.

### Using Docker

> Docker image: `ghcr.io/redf0x1/camofox-browser`

```bash
docker build -t camofox-browser .
docker run -d \
  --name camofox-browser \
  -p 9377:9377 \
  -p 6080:6080 \
  -v ~/.camofox:/home/node/.camofox \
  camofox-browser
```

To persist browser profiles (cookies, localStorage, IndexedDB, etc.) across container restarts, keep the volume mount shown above.

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
      # Optional fingerprint tuning
      # CAMOFOX_OS: "windows,macos"
      # CAMOFOX_ALLOW_WEBGL: "true"
      # CAMOFOX_HUMANIZE: "true"
      # CAMOFOX_SCREEN_WIDTH: "1920"
      # CAMOFOX_SCREEN_HEIGHT: "1080"
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

## CLI

CamoFox Browser includes a powerful CLI for browser automation directly from the terminal. The CLI auto-starts the server when needed.

### Installation

```bash
# Global install (recommended)
npm install -g camofox-browser

# Or use npx (no install needed)
npx camofox-browser open https://example.com
```

### Quick Start

```bash
camofox open https://example.com       # Open a page in anti-detection browser
camofox snapshot                       # Get accessibility tree with element refs
camofox click e5                       # Click element [e5]
camofox type e3 "hello world"         # Type into element [e3]
camofox screenshot --output page.png   # Save screenshot
camofox close                          # Close the tab
```

### Core Commands

```bash
# Browser lifecycle
camofox open <url>                     # Open URL in new tab
camofox close [tabId]                  # Close tab
camofox navigate <url>                 # Navigate current tab to URL

# Inspection
camofox snapshot                       # Get accessibility tree with [eN] refs
camofox screenshot [--output file]     # Take screenshot (saves to file)
camofox annotate                       # Screenshot + element ref overlay
camofox get-url                        # Get current page URL
camofox get-text                       # Get page text content
camofox get-links                      # Get all links on page
camofox get-tabs                       # List open tabs

# Interaction
camofox click <ref>                    # Click element by ref
camofox type <ref> <text>              # Type text into element
camofox fill '[e1]="user" [e2]="pw"'  # Fill multiple fields at once
camofox scroll <direction>             # Scroll up/down/left/right
camofox select <ref> <value>           # Select dropdown option
camofox hover <ref>                    # Hover over element
camofox press <key>                    # Press keyboard key
camofox drag <from> <to>               # Drag element to target

# Navigation
camofox go-back                        # Browser back
camofox go-forward                     # Browser forward
camofox search "query" --engine google # Search (14 engines supported)
camofox eval "document.title"          # Execute JavaScript
camofox wait <selector> [--timeout ms] # Wait for element
```

> **Text input:** CamoFox has no character limit for typed or filled text. Short text stays humanized for anti-detection, while long text automatically switches to bulk DOM insertion so large inputs do not truncate.

### Session Management

```bash
camofox session save <name>            # Save current browser state
camofox session load <name>            # Restore browser state
camofox session list                   # List saved sessions
camofox session delete <name>          # Delete saved session
```

### Cookie Management

```bash
camofox cookie export <file>           # Export cookies to JSON file
camofox cookie import <file>           # Import cookies from JSON file
```

### Auth Vault

Securely store credentials locally with AES-256-GCM encryption. Credentials are **never** output to stdout — safe for LLM agent automation.

```bash
camofox auth save <profile> [--url URL]  # Save credentials (prompts for master password)
camofox auth load <profile>              # Show profile info (username only)
camofox auth list                        # List saved profiles (no secrets shown)
camofox auth delete <profile>            # Delete a profile
camofox auth change-password <profile>   # Change master password

# Inject credentials into a browser tab (LLM-safe)
camofox snapshot                         # Get element refs first
camofox auth load gmail --inject --username-ref e5 --password-ref e12
```

> **Security:** Master passwords use Argon2id KDF (with PBKDF2 fallback). Vault files are stored with 0600 permissions. The `--inject` flag sends credentials directly to the browser — the LLM agent never sees the password.

### Pipeline Scripting

Execute multiple commands from a file for automation workflows:

```bash
# Create a script
cat > login-flow.txt << 'EOF'
# Login automation script
open https://example.com/login
snapshot
type e3 "username"
type e5 "password"
click e7
wait .dashboard --timeout 5000
screenshot --output result.png
close
EOF

# Run it
camofox run login-flow.txt

# Continue on errors
camofox run login-flow.txt --continue-on-error

# Read from stdin
echo "get-url" | camofox run -
```

### Server Management

```bash
camofox server start                   # Start server daemon
camofox server start --background      # Start in background
camofox server stop                    # Stop server daemon
camofox server status                  # Check server status
```

### Diagnostics

```bash
camofox health                         # System health report
camofox version                        # CLI + server version
camofox info                           # Configuration info
```

### Console Capture

```bash
camofox console [tabId]                  # View console messages
camofox console [tabId] --type error     # Filter by type (log/warning/error/info/debug)
camofox console [tabId] --clear          # View then clear messages
camofox errors [tabId]                   # View uncaught JavaScript errors
camofox errors [tabId] --clear           # View then clear errors
```

### Playwright Tracing

```bash
camofox trace start [tabId]              # Start recording trace
camofox trace stop [tabId] [-o file.zip] # Stop and save trace ZIP
camofox trace chunk-start [tabId]        # Start new trace chunk
camofox trace chunk-stop [tabId] [-o f]  # Stop chunk and save ZIP
camofox trace status [tabId]             # Check active trace status
```

View traces at [trace.playwright.dev](https://trace.playwright.dev)

### Global Options

| Flag | Env Var | Description | Default |
|------|---------|-------------|---------|
| `--user <id>` | `CAMOFOX_USER` | User/profile ID | `cli-default` |
| `--port <port>` | `PORT` | Server port | `9377` |
| `--format <fmt>` | — | Output: `json`, `text`, `plain` | `text` |
| `-V, --version` | — | Show version | — |
| `-h, --help` | — | Show help | — |

### Output Formats

```bash
camofox get-url --format json          # {"url":"https://example.com"}
camofox get-url --format text          # URL: https://example.com
camofox get-url --format plain         # https://example.com
```

> **Tip:** Use `--format json` for programmatic parsing and LLM agent integration.

## Security

### Anti-Detection
CamoFox uses [Camoufox](https://github.com/daijro/camoufox), a Firefox fork with **C++ level fingerprint spoofing**. Unlike Chromium-based tools, CamoFox passes bot detection on Google, Cloudflare, and other anti-bot services.

### Auth Vault
- **AES-256-GCM** encryption with **Argon2id** key derivation (PBKDF2 fallback)
- Credentials **never** appear in stdout (safe for LLM agent pipelines)
- Vault files stored with `0600` permissions
- Master password required for all vault operations

### LLM Agent Safety
- The `--inject` flag sends credentials directly to the browser — the LLM agent orchestrating the CLI never sees raw passwords
- Output formats are designed for safe parsing without credential exposure
- Pipeline scripts can reference auth profiles without embedding secrets

## Usage with AI Agents

CamoFox works seamlessly with AI coding agents and LLM-powered automation:

### AI Coding Assistants (Recommended)

Add CamoFox skills to your AI coding assistant for full browser automation context:

```bash
npx skills add redf0x1/camofox-browser
```

This works with **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, **GitHub Copilot**, **Goose**, **OpenCode**, **Windsurf**, and [40+ other agents](https://github.com/vercel-labs/skills#supported-agents).

**Available skills:**

| Skill | Focus | Best For |
|-------|-------|----------|
| `camofox-browser` | Full coverage (CLI + API + OpenClaw) | Complete reference |
| `camofox-cli` | CLI-only (50 commands) | Terminal-first workflows |
| `dogfood` | QA testing workflow | Systematic web app testing |
| `gemini-image` | Gemini image generation | AI image automation |
| `reddit` | Reddit automation | Reddit posting/commenting |

The installer will prompt you to choose which skills and which agents to configure.

#### Claude Code

```bash
npx skills add redf0x1/camofox-browser
# Installs to .claude/skills/camofox-browser/SKILL.md
```

#### Cursor / GitHub Copilot / Codex

```bash
npx skills add redf0x1/camofox-browser
# Installs to .agents/skills/ directory
```

> **Tip:** Skills are symlinked from the repo, so they stay up to date. Do not manually copy `SKILL.md` files.

### MCP Integration (Recommended)
Use [CamoFox MCP](https://github.com/redf0x1/camofox-mcp) for direct integration with Claude, Cursor, Windsurf, and other MCP-compatible agents. See [Used With](#used-with).

### CLI Integration
AI agents can use the CLI with `--format json` for structured output:

```bash
camofox open https://example.com       # Open page
camofox snapshot --format json         # Get structured element tree
camofox click e5                       # Interact with elements
camofox auth load gmail --inject --username-ref e5 --password-ref e12  # Safe credential injection
```

### Pipeline Automation
Create reusable automation scripts that AI agents can execute:

```bash
camofox run automation-flow.txt        # Execute multi-step workflow
```

## Architecture

```text
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
| POST | `/sessions/:userId/cookies` | Import cookies into a user session (Playwright cookie objects) | Path: `userId`; Body: `{ "cookies": Cookie[] }` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/health` | Health check (also pre-launches the browser) | None | None |
| GET | `/presets` | List available geo presets (built-in + custom) | None | None |
| POST | `/tabs` | Create a new tab (supports `preset` + per-field overrides) | Body: `userId` + (`sessionKey` or `listItemId`) | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs?userId=...` | List all tabs for a user (OpenClaw-compatible response shape) | Query: `userId` | None |
| POST | `/tabs/:tabId/navigate` | Navigate to a URL, or expand a search `macro` + `query` | Body: `userId` + (`url` or `macro`) | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/snapshot?userId=...` | Accessibility snapshot annotated with `eN` element refs | Query: `userId` | None |
| POST | `/tabs/:tabId/wait` | Wait for page readiness (DOM + optional network idle) | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/click` | Click by `ref` (e.g. `e12`) or CSS `selector` | Body: `userId` + (`ref` or `selector`) | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/type` | Type into an element by `ref` or CSS `selector` | Body: `userId` + (`ref` or `selector`) + `text` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/press` | Press a key (e.g. `Enter`, `Escape`) | Body: `userId` + `key` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/scroll` | Scroll up/down/left/right by pixels | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/scroll-element` | Scroll specific element into view | Body: userId, ref/selector | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/back` | Go back | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/forward` | Go forward | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/refresh` | Refresh | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/links?userId=...&limit=50&offset=0` | Extract links (paginated) | Query: `userId` | None |
| GET | `/tabs/:tabId/screenshot?userId=...&fullPage=true` | Screenshot (PNG bytes) | Query: `userId` | None |
| GET | `/tabs/:tabId/stats?userId=...` | Tab stats + visited URLs | Query: `userId` | None |
| DELETE | `/tabs/:tabId` | Close a tab (expects JSON body: `{ "userId": "..." }`) | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| DELETE | `/tabs/group/:listItemId` | Close a tab group (expects JSON body: `{ "userId": "..." }`) | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| DELETE | `/sessions/:userId` | Close all sessions for a user | Path: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/sessions/:userId/toggle-display` | Toggle display mode (headless/headed/virtual) | Path: `userId`; Body: `{ "headless": true\|false\|"virtual" }` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/cookies` | Export tab cookies | Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/downloads` | List tab downloads | Query: `userId` | None |
| GET | `/users/:userId/downloads` | List user downloads | Path: `userId` | None |
| GET | `/downloads/:downloadId` | Download metadata | Query: `userId` | None |
| GET | `/downloads/:downloadId/content` | Stream download content | Query: `userId` | None |
| DELETE | `/downloads/:downloadId` | Delete tracked download | Body or Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/extract-resources` | Extract downloadable resources | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/batch-download` | Batch download resources | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/resolve-blobs` | Resolve blob URLs to base64 | Body: `userId` + `urls[]` | None |
| POST | `/tabs/:tabId/trace/start` | Start trace recording | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/trace/stop` | Stop and save trace ZIP | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/trace/chunk/start` | Start trace chunk | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/trace/chunk/stop` | Stop chunk and save ZIP | Body: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/trace/status` | Check trace status | Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/console` | Get console messages | Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/tabs/:tabId/errors` | Get uncaught JS errors | Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/tabs/:tabId/console/clear` | Clear console + errors | Body or Query: `userId` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |

### Toggle Display Mode
```bash
POST /sessions/:userId/toggle-display
{"headless": "virtual"}
```
**Auth:** Conditional — requires `Authorization: Bearer $CAMOFOX_API_KEY` when `CAMOFOX_API_KEY` is set.
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

### Evaluate JavaScript
Execute a JavaScript expression in the page context and return the JSON-serializable result.

Auth: required only when `CAMOFOX_API_KEY` is set on the server; otherwise no auth is required.

Note: async expressions must be wrapped in an async IIFE (for example, `(async () => { ... })()`). Top-level `await` is not supported.

```bash
POST /tabs/:tabId/evaluate
{"userId": "agent1", "expression": "document.title"}
```
Returns: `{"ok": true, "result": "Page Title", "resultType": "string", "truncated": false}`

### Evaluate JavaScript (Extended)
Execute a long-running JavaScript expression (up to 300s timeout). Conditionally API-key protected. Rate limited.

Auth: required only when `CAMOFOX_API_KEY` is set on the server; otherwise no auth is required.

Note: async expressions must be wrapped in an async IIFE (for example, `(async () => { ... })()`). Top-level `await` is not supported.

```bash
POST /tabs/:tabId/evaluate-extended
{"userId": "agent1", "expression": "(async () => { const response = await fetch('/api/data'); return await response.json(); })()", "timeout": 60000}
```
Returns: `{"ok": true, "result": {...}, "resultType": "object", "truncated": false}`

### OpenClaw Endpoints

OpenClaw-compatible aliases (used by the OpenClaw plugin).

| Method | Endpoint | Description | Required | Auth |
|--------|----------|-------------|----------|------|
| GET | `/` | Status (alias of `/health`) | None | None |
| POST | `/tabs/open` | Open tab (OpenClaw request/response shape) | Body: `userId` + `url` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| POST | `/start` | Start browser engine | None | None |
| POST | `/stop` | Stop browser engine | None | `x-admin-key: $CAMOFOX_ADMIN_KEY` |
| POST | `/navigate` | Navigate (OpenClaw request shape: `targetId` in body) | Body: `userId` + `targetId` + `url` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |
| GET | `/snapshot?userId=...&targetId=...` | Snapshot (OpenClaw response shape) | Query: `userId` + `targetId` | None |
| POST | `/act` | Combined actions (`click`, `type`, `press`, `scroll`, `scrollIntoView`, `hover`, `wait`, `close`) | Body: `userId` + `targetId` + `kind` | Conditional: `Authorization: Bearer $CAMOFOX_API_KEY` |

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
| `CAMOFOX_API_KEY` | (empty) | When set, conditionally guards protected endpoints (tab creation, navigation, interaction, session management, downloads, tracing, console) via `Authorization: Bearer` header. Unset = no auth enforced. |
| `CAMOFOX_HEADLESS` | `true` | Display mode: `true` (headless), `false` (headed), `virtual` (Xvfb) |
| `CAMOFOX_OS` | host OS | Camoufox OS fingerprint target. Accepts `windows`, `macos`, `linux`, or a comma-separated list such as `windows,macos` for randomized selection. |
| `CAMOFOX_ALLOW_WEBGL` | `false` | Whether to expose and spoof WebGL instead of blocking it. Accepts `true`/`false` or `1`/`0`. |
| `CAMOFOX_HUMANIZE` | `true` | Whether Camoufox should humanize interactions. Accepts `true`/`false` or `1`/`0`. |
| `CAMOFOX_SCREEN_WIDTH` | (unset) | Screen width to pass to Camoufox fingerprint configuration. Must be set together with `CAMOFOX_SCREEN_HEIGHT`. |
| `CAMOFOX_SCREEN_HEIGHT` | (unset) | Screen height to pass to Camoufox fingerprint configuration. Must be set together with `CAMOFOX_SCREEN_WIDTH`. |
| `CAMOFOX_VNC_RESOLUTION` | `1920x1080x24` | Virtual Xvfb display resolution (`WIDTHxHEIGHTxDEPTH`) |
| `CAMOFOX_VNC_TIMEOUT_MS` | `120000` | Max VNC session duration in ms before auto-stop |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX` | `20` | Max evaluate-extended requests per user per window |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window duration in ms |
| `CAMOFOX_COOKIES_DIR` | `~/.camofox/cookies` | Directory used by the OpenClaw plugin cookie tool |
| `CAMOFOX_PROFILES_DIR` | `~/.camofox/profiles` | Profile storage directory (persistent per-user Firefox profiles) |
| `CAMOFOX_DOWNLOADS_DIR` | `~/.camofox/downloads` | Download artifact directory |
| `CAMOFOX_DOWNLOAD_TTL_MS` | `86400000` | Download metadata retention TTL |
| `CAMOFOX_MAX_DOWNLOAD_SIZE_MB` | `100` | Max single download size |
| `CAMOFOX_MAX_BATCH_CONCURRENCY` | `5` | Batch download concurrency cap |
| `CAMOFOX_MAX_BLOB_SIZE_MB` | `5` | Max blob payload size |
| `CAMOFOX_MAX_DOWNLOADS_PER_USER` | `500` | Per-user download record cap |
| `HANDLER_TIMEOUT_MS` | `30000` | Handler timeout fallback |
| `MAX_CONCURRENT_PER_USER` | `3` | Concurrent operations per user |
| `CAMOFOX_VNC_BASE_PORT` | `6080` | noVNC/websockify base port |
| `CAMOFOX_VNC_HOST` | `localhost` | noVNC host in returned URL |
| `CAMOFOX_CLI_USER` | `cli-default` | Default CLI user id |
| `CAMOFOX_IDLE_TIMEOUT_MS` | `1800000` | CLI server idle timeout |
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
  -e CAMOFOX_OS=windows \
  -e CAMOFOX_ALLOW_WEBGL=true \
  -e CAMOFOX_HUMANIZE=true \
  -e CAMOFOX_SCREEN_WIDTH=1920 \
  -e CAMOFOX_SCREEN_HEIGHT=1080 \
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

- Node.js 20+
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
├── cli/
│   ├── commands/       # Command modules (core, navigation, interaction, etc.)
│   │   ├── console.ts   # Console capture commands
│   │   └── trace.ts     # Playwright tracing commands
│   ├── vault/          # Auth vault (encryption, storage)
│   ├── server/         # Server lifecycle management
│   ├── transport/      # HTTP transport layer
│   ├── output/         # Output formatting
│   └── utils/          # Shared utilities
├── server.ts           # Express app entry point
├── types.ts            # Shared TypeScript interfaces
├── routes/
│   ├── core.ts         # Core REST API (~42 endpoints)
│   └── openclaw.ts     # OpenClaw compatibility (~7 endpoints)
├── services/
│   ├── browser.ts      # Browser lifecycle + persistent context pool
│   ├── batch-downloader.ts # Batch download orchestrator
│   ├── context-pool.ts # Browser context pool with LRU eviction
│   ├── download.ts     # Download tracking service
│   ├── health.ts       # Browser health tracking
│   ├── resource-extractor.ts # Page resource extraction
│   ├── session.ts      # Session management + limits
│   ├── tab.ts          # Tab operations (snapshot/click/type/etc.)
│   ├── tracing.ts      # Playwright tracing service
│   ├── vnc.ts          # VNC/virtual display lifecycle
│   └── youtube.ts      # YouTube transcript extraction
├── middleware/
│   ├── auth.ts         # API/admin auth helpers
│   ├── errors.ts       # Error handling
│   ├── logging.ts      # Structured logging
│   └── rate-limit.ts   # In-memory rate limiter
└── utils/
  ├── config.ts       # Environment config parsing
  ├── cookies.ts      # Cookie utilities
  ├── download-helpers.ts # Download helper functions
  ├── launcher.ts     # Browser launcher utilities
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
