# camofox-browser — Agent Guide

> Anti-detection browser automation server. REST API on port 9377, CLI via `camofox`, MCP via `camofox-mcp`.

This guide is source-verified against:
- `src/cli/commands/*.ts`
- `src/routes/core.ts`
- `src/routes/openclaw.ts`
- `src/utils/macros.ts`
- `src/utils/presets.ts`
- `src/utils/config.ts`

## Quick Start

```bash
# from source
npm install
npm run build
npm start                                  # server on http://localhost:9377

# CLI (auto-starts server when needed)
npx camofox open https://example.com       # open tab
npx camofox snapshot                       # get snapshot with refs
npx camofox click e5                       # click ref
```

```bash
# npm global install
npm install -g camofox-browser
camofox open https://example.com
```

## Core Workflow

1. Open/create tab first (`open` or `POST /tabs`) before interaction commands.
2. Snapshot before interacting to get fresh `eN` refs.
3. Prefer refs over fragile selectors for repeatable automation.
4. Re-snapshot after navigation, major DOM updates, or modal transitions.
5. Keep `userId` stable per actor to preserve cookies/profile continuity.
6. Use `sessionKey` (or legacy `listItemId`) to group tabs by task.
7. Use `--format json` for machine parsing; avoid parsing human text output.

Warnings:
- Refs are page-state dependent and can become stale quickly.
- `POST /sessions/:userId/toggle-display` restarts context and invalidates tabs.
- `DELETE /sessions/:userId` closes all contexts/tabs for that user.

## CLI Reference

### Core Commands

```bash
camofox open <url> [--user <user>] [--viewport <WxH>] [--geo <preset>]  # create tab and set active tab
camofox close [tabId] [--user <user>]                                     # close tab (default active)
camofox snapshot [tabId] [--user <user>]                                  # accessibility snapshot
camofox click <ref> [tabId] [--user <user>]                               # click ref or selector text
camofox type <ref> <text> [tabId] [--user <user>]                         # type text into element
```

### Navigation Commands

```bash
camofox navigate <url> [tabId] [--user <user>]                            # navigate tab
camofox screenshot [tabId] [--path <file>|--output <file>] [--full-page] [--user <user>]  # save PNG
camofox go-back [tabId] [--user <user>]                                   # back
camofox go-forward [tabId] [--user <user>]                                # forward
```

### Interaction Commands

```bash
camofox fill <assignments> [tabId] [--user <user>]                        # [e1]="value" [e2]="value"
camofox scroll [direction] [tabId] [--amount <N>] [--user <user>]         # up|down|left|right
camofox select <ref> <value> [tabId] [--user <user>]                      # select dropdown option
camofox hover <ref> [tabId] [--user <user>]                               # hover ref/selector
camofox press <key> [tabId] [--user <user>]                               # keyboard press
camofox drag <fromRef> <toRef> [tabId] [--user <user>]                    # drag and drop
```

### Content & Inspection Commands

```bash
camofox get-text [tabId] [--selector <selector>] [--user <user>]          # extract page/selector text
camofox get-url [tabId] [--user <user>]                                   # current URL
camofox get-links [tabId] [--user <user>]                                 # links list
camofox get-tabs [--user <user>]                                          # list tabs
camofox eval <expression> [tabId] [--user <user>]                         # evaluate JS
camofox wait <condition> [tabId] [--timeout <ms>] [--user <user>]         # selector|navigation|networkidle
camofox search <query> [tabId] [--engine <engine>] [--user <user>]        # google|youtube|amazon|bing|reddit|duckduckgo|github|stackoverflow
```

### Session Management

```bash
camofox session save <name> [tabId] [--user <user>]                       # save cookies to ~/.camofox/sessions
camofox session load <name> [tabId] [--user <user>]                       # restore cookies from file
camofox session list [--format <format>]                                  # list session files
camofox session delete <name> [--force]                                   # delete saved session
```

### Auth Vault

```bash
camofox auth save <profile-name> [--url <url>] [--notes <notes>]          # save encrypted credentials
camofox auth load <profile-name>                                           # load username only
camofox auth load <profile-name> --inject [tabId] --username-ref <ref> --password-ref <ref> [--user <user>]  # inject to page
camofox auth list [--format <format>]                                      # list profiles
camofox auth delete <profile-name>                                         # delete profile
camofox auth change-password <profile-name>                                # rotate master password
```

### Cookie & Downloads

```bash
camofox cookie export [tabId] [--path <file>] [--user <user>]             # export tab cookies JSON
camofox cookie import <file> [tabId] [--user <user>]                      # import cookies JSON
camofox download [url] [--path <dir>] [--user <user>]                     # placeholder; requires server v2+ direct endpoint
camofox downloads [--user <user>] [--format <format>]                     # list tracked downloads
```

### Console Commands
| Command | Description |
|---------|-------------|
| `camofox console [tabId]` | View console messages (filtered by --type, clearable with --clear) |
| `camofox errors [tabId]` | View uncaught JavaScript errors (clearable with --clear) |

### Trace Commands
| Command | Description |
|---------|-------------|
| `camofox trace start [tabId]` | Start recording Playwright trace |
| `camofox trace stop [tabId]` | Stop and save trace ZIP (-o for output path) |
| `camofox trace chunk-start [tabId]` | Start new trace chunk within active trace |
| `camofox trace chunk-stop [tabId]` | Stop chunk and save ZIP |
| `camofox trace status [tabId]` | Check trace recording status |

### Server Management

```bash
camofox server start [--port <port>] [--background] [--idle-timeout <minutes>]  # start server
camofox server stop                                                           # stop daemon
camofox server status [--format <format>]                                    # running/stopped status
```

### Pipeline Scripting

```bash
camofox run <script-file> [--continue-on-error]                            # execute command script

# example script with full-line comments
# open page
open https://example.com
# get refs
snapshot
# type
type e3 "hello"
# click
click e7
# save proof
screenshot --output result.png
```

### Diagnostics

```bash
camofox annotate [tabId] [--user <user>] [--output <file>] [--format <format>]  # screenshot + refs map
camofox health [--format <format>]                                              # server/browser/vault health
camofox version [--format <format>]                                             # CLI/server/node versions
camofox info [--format <format>]                                                # active state and directories
```

### Global Options

```bash
--user <user>                # default user id (overrides CAMOFOX_CLI_USER)
--port <port>                # server port (overrides CAMOFOX_PORT)
--format <format>            # json|text|plain (default text)
--local                      # reserved for v2 (currently rejected)
-V, --version                # CLI version
-h, --help                   # command help
```

## REST API Reference

Base URL: `http://localhost:9377`

### Core Endpoints

| Method | Endpoint | Purpose | Required params | Auth |
|---|---|---|---|---|
| POST | `/sessions/:userId/cookies` | Import cookies into user context | Path: `userId`; Body: `cookies[]`; optional `tabId` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| GET | `/tabs/:tabId/cookies` | Export tab cookies | Path: `tabId`; Query: `userId` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| GET | `/health` | Health + pool/profile status | none | none |
| GET | `/presets` | List geo presets | none | none |
| POST | `/tabs` | Create tab | Body: `userId` + (`sessionKey` or `listItemId`) | none |
| GET | `/tabs` | List user tabs | Query: `userId` | none |
| POST | `/tabs/:tabId/navigate` | Navigate URL or macro | Body: `userId` + (`url` or `macro`) | none |
| GET | `/tabs/:tabId/snapshot` | Snapshot with refs | Query: `userId` | none |
| POST | `/tabs/:tabId/wait` | Wait for page ready | Body: `userId`; optional `timeout`, `waitForNetwork` | none |
| POST | `/tabs/:tabId/click` | Click element | Body: `userId` + (`ref` or `selector`) | none |
| POST | `/tabs/:tabId/type` | Type text | Body: `userId`; optional `ref`/`selector`; `text` | none |
| POST | `/tabs/:tabId/press` | Press key | Body: `userId`, `key` | none |
| POST | `/tabs/:tabId/scroll` | Scroll page | Body: `userId`; optional `direction`, `amount` | none |
| POST | `/tabs/:tabId/scroll-element` | Scroll specific element | Body: `userId` + (`ref` or `selector`); optional `deltaX`, `deltaY`, `scrollTo` | none |
| POST | `/tabs/:tabId/evaluate` | Evaluate JS (standard timeout) | Body: `userId`, `expression`; optional `timeout` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/evaluate-extended` | Evaluate JS (up to 300s + rate limit) | Body: `userId`, `expression`; optional `timeout` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/back` | Browser back | Body: `userId` | none |
| POST | `/tabs/:tabId/forward` | Browser forward | Body: `userId` | none |
| POST | `/tabs/:tabId/refresh` | Refresh | Body: `userId` | none |
| GET | `/tabs/:tabId/links` | Extract links | Query: `userId`; optional `limit`, `offset`, `scope`, `extension`, `downloadOnly` | none |
| GET | `/tabs/:tabId/screenshot` | Screenshot PNG bytes | Query: `userId`; optional `fullPage=true` | none |
| GET | `/tabs/:tabId/stats` | Tab stats/visited URLs | Query: `userId` | none |
| DELETE | `/tabs/:tabId` | Close tab | Body: `userId` | none |
| DELETE | `/tabs/group/:listItemId` | Close tab group | Body: `userId` | none |
| DELETE | `/sessions/:userId` | Close user sessions | Path: `userId` | none |
| POST | `/sessions/:userId/toggle-display` | Toggle display mode and restart context | Path: `userId`; Body: `headless` (`true`/`false`/`virtual`) | none |
| GET | `/tabs/:tabId/downloads` | List tab downloads | Path: `tabId`; Query: `userId`; optional filters | none |
| GET | `/users/:userId/downloads` | List user downloads | Path: `userId`; optional filters | none |
| GET | `/downloads/:downloadId` | Get download metadata | Path: `downloadId`; Query: `userId` | none |
| GET | `/downloads/:downloadId/content` | Stream download content | Path: `downloadId`; Query: `userId` | none |
| DELETE | `/downloads/:downloadId` | Delete tracked download | Path: `downloadId`; Body/Query: `userId` | none |
| POST | `/tabs/:tabId/extract-resources` | Extract downloadable resources | Path: `tabId`; Body: `userId` + extractor options | none |
| POST | `/tabs/:tabId/batch-download` | Batch download resources | Path: `tabId`; Body: `userId` + batch options | none |
| POST | `/tabs/:tabId/resolve-blobs` | Resolve `blob:` URLs to base64 | Path: `tabId`; Body: `userId`, `urls[]` | none |
| POST | `/tabs/:tabId/trace/start` | Start trace recording | Path: `tabId`; Body: `userId`; optional `screenshots`, `snapshots` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/trace/stop` | Stop and save trace ZIP | Path: `tabId`; Body: `userId`; optional `path` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/trace/chunk/start` | Start trace chunk | Path: `tabId`; Body: `userId` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/trace/chunk/stop` | Stop chunk and save ZIP | Path: `tabId`; Body: `userId`; optional `path` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| GET | `/tabs/:tabId/trace/status` | Check trace status | Path: `tabId`; Query: `userId` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| GET | `/tabs/:tabId/console` | Get console messages | Path: `tabId`; Query: `userId`; optional `type`, `limit` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| GET | `/tabs/:tabId/errors` | Get uncaught JS errors | Path: `tabId`; Query: `userId`; optional `limit` | Bearer API key only when `CAMOFOX_API_KEY` is set |
| POST | `/tabs/:tabId/console/clear` | Clear console and errors | Path: `tabId`; Body/Query: `userId` | Bearer API key only when `CAMOFOX_API_KEY` is set |

### OpenClaw Endpoints

| Method | Endpoint | Purpose | Required params | Auth |
|---|---|---|---|---|
| GET | `/` | Status alias | none | none |
| POST | `/tabs/open` | Open tab (OpenClaw shape) | Body: `userId`, `url`; optional `listItemId` | none |
| POST | `/start` | Start profile (compat response) | none | none |
| POST | `/stop` | Stop browser and clear state | none | `x-admin-key` required on every request (must match configured admin key) |
| POST | `/navigate` | Navigate by `targetId` | Body: `userId`, `targetId`, `url` | none |
| GET | `/snapshot` | Snapshot by `targetId` | Query: `userId`, `targetId`; optional `format` | none |
| POST | `/act` | Multi-action endpoint | Body: `userId`, `targetId`, `kind` + kind params | none |

### Authentication

- API key (`Authorization: Bearer ...`) is conditionally required only when `CAMOFOX_API_KEY` is configured.
- Admin key (`x-admin-key`) is required for every OpenClaw `POST /stop` request and must match configured admin key value.
- Most routes remain open by default if keys are unset, except OpenClaw `POST /stop` still requires `x-admin-key`.

## Search Macros (14)

Source of truth: `src/utils/macros.ts`

| Macro | URL target |
|---|---|
| `@google_search` | `https://www.google.com/search?q=...` |
| `@youtube_search` | `https://www.youtube.com/results?search_query=...` |
| `@amazon_search` | `https://www.amazon.com/s?k=...` |
| `@reddit_search` | `https://www.reddit.com/search.json?q=...&limit=25` |
| `@reddit_subreddit` | `https://www.reddit.com/r/<query-or-all>.json?limit=25` |
| `@wikipedia_search` | `https://en.wikipedia.org/wiki/Special:Search?search=...` |
| `@twitter_search` | `https://twitter.com/search?q=...` |
| `@yelp_search` | `https://www.yelp.com/search?find_desc=...` |
| `@spotify_search` | `https://open.spotify.com/search/...` |
| `@netflix_search` | `https://www.netflix.com/search?q=...` |
| `@linkedin_search` | `https://www.linkedin.com/search/results/all/?keywords=...` |
| `@instagram_search` | `https://www.instagram.com/explore/tags/...` |
| `@tiktok_search` | `https://www.tiktok.com/search?q=...` |
| `@twitch_search` | `https://www.twitch.tv/search?term=...` |

## Geo Presets

Source of truth: `src/utils/presets.ts` (`BUILT_IN_PRESETS`)

| Preset | Locale | Timezone | Coordinates |
|---|---|---|---|
| `us-east` | `en-US` | `America/New_York` | `40.7128, -74.006` |
| `us-west` | `en-US` | `America/Los_Angeles` | `34.0522, -118.2437` |
| `japan` | `ja-JP` | `Asia/Tokyo` | `35.6895, 139.6917` |
| `uk` | `en-GB` | `Europe/London` | `51.5074, -0.1278` |
| `germany` | `de-DE` | `Europe/Berlin` | `52.52, 13.405` |
| `vietnam` | `vi-VN` | `Asia/Ho_Chi_Minh` | `10.8231, 106.6297` |
| `singapore` | `en-SG` | `Asia/Singapore` | `1.3521, 103.8198` |
| `australia` | `en-AU` | `Australia/Sydney` | `-33.8688, 151.2093` |

Custom presets:

```bash
export CAMOFOX_PRESETS_FILE=/path/to/presets.json    # load custom preset object
curl http://localhost:9377/presets                    # verify merged preset list
```

## Element Refs (eN System)

Refs are returned by snapshot endpoints and represent current-page element targets.

Rules:
1. Always snapshot before click/type/hover/select actions.
2. Treat refs as ephemeral across navigation and dynamic rerenders.
3. Re-snapshot after any action that can mutate the DOM heavily.
4. Prefer refs for LLM workflows; use selectors as fallback only.
5. Keep tab/user pairing consistent (`tabId` is user-scoped in server lookup).
6. Don’t reuse refs from different tabs, users, or stale snapshots.

Typical loop:

```bash
camofox snapshot --format json                    # fetch refs
camofox click e12                                 # act by ref
camofox snapshot --format json                    # refresh refs after DOM change
```

## Anti-Patterns

### 1) Acting without snapshot

```bash
# BAD
camofox click e8                                   # stale/unknown ref likely

# GOOD
camofox snapshot
camofox click e8
```

### 2) Mixing user identities in one flow

```bash
# BAD
camofox open https://example.com --user a
camofox click e5 --user b                          # tab lookup fails

# GOOD
camofox open https://example.com --user a
camofox click e5 --user a
```

### 3) Parsing human text output in automation

```bash
# BAD
camofox get-url | cut -d' ' -f2

# GOOD
camofox get-url --format json
```

### 4) Hard-coding search URLs when macros exist

```bash
# BAD
camofox navigate "https://www.google.com/search?q=llm" 

# GOOD
curl -X POST http://localhost:9377/tabs/$TAB/navigate \
	-H 'Content-Type: application/json' \
	-d '{"userId":"agent1","macro":"@google_search","query":"llm"}'
```

### 5) Expecting tabs to survive display toggle

```bash
# BAD
curl -X POST http://localhost:9377/sessions/agent1/toggle-display -d '{"headless":"virtual"}'
# then reusing old tabId

# GOOD
curl -X POST http://localhost:9377/sessions/agent1/toggle-display -d '{"headless":"virtual"}'
# open a new tab after restart
```

### 6) Storing plaintext credentials in scripts

```bash
# BAD
type e5 "my-email"
type e8 "my-password"

# GOOD
camofox auth save gmail
camofox auth load gmail --inject --username-ref e5 --password-ref e8
```

### 7) Closing only tabs when full user cleanup is needed

```bash
# BAD
curl -X DELETE http://localhost:9377/tabs/$TAB

# GOOD
curl -X DELETE http://localhost:9377/sessions/agent1
```

### 8) Assuming `download` CLI command performs direct download today

```bash
# BAD
camofox download https://example.com/file.zip

# GOOD
camofox downloads --format json                    # inspect tracked downloads
# or use /tabs/:tabId/batch-download via API
```

## Environment Variables

Source of truth: `src/utils/config.ts`, `src/services/session.ts`, `src/services/vnc.ts`, `src/cli/*`

| Variable | Default | Description |
|---|---|---|
| `CAMOFOX_PORT` | `9377` | Primary server port |
| `PORT` | unset | Alternate port fallback |
| `NODE_ENV` | `development` | Node environment label |
| `CAMOFOX_ADMIN_KEY` | empty | Admin key for `POST /stop` |
| `CAMOFOX_API_KEY` | empty | Conditional API-key auth for cookie/eval routes |
| `CAMOFOX_COOKIES_DIR` | `~/.camofox/cookies` | Cookie storage directory |
| `CAMOFOX_PROFILES_DIR` | `~/.camofox/profiles` | Persistent browser profiles directory |
| `CAMOFOX_DOWNLOADS_DIR` | `~/.camofox/downloads` | Download artifact directory |
| `CAMOFOX_DOWNLOAD_TTL_MS` | `86400000` | Download metadata/artifact retention TTL |
| `CAMOFOX_MAX_DOWNLOAD_SIZE_MB` | `100` | Max single download size |
| `CAMOFOX_MAX_BATCH_CONCURRENCY` | `5` | Batch download concurrency cap |
| `CAMOFOX_MAX_BLOB_SIZE_MB` | `5` | Max blob payload size |
| `CAMOFOX_MAX_DOWNLOADS_PER_USER` | `500` | Per-user download record cap |
| `HANDLER_TIMEOUT_MS` | `30000` | Handler timeout fallback |
| `MAX_CONCURRENT_PER_USER` | `3` | Concurrent operations per user |
| `CAMOFOX_MAX_SNAPSHOT_CHARS` | `80000` | Snapshot truncation cap |
| `CAMOFOX_SNAPSHOT_TAIL_CHARS` | `5000` | Tail chars retained in truncated snapshots |
| `CAMOFOX_BUILDREFS_TIMEOUT_MS` | `12000` | Ref-building timeout |
| `CAMOFOX_TAB_LOCK_TIMEOUT_MS` | `30000` | Per-tab lock timeout |
| `CAMOFOX_HEALTH_PROBE_INTERVAL_MS` | `60000` | Health probe interval |
| `CAMOFOX_FAILURE_THRESHOLD` | `3` | Failure threshold for degraded health |
| `CAMOFOX_YT_DLP_TIMEOUT_MS` | `30000` | yt-dlp timeout (service layer) |
| `CAMOFOX_YT_BROWSER_TIMEOUT_MS` | `25000` | Browser transcript fallback timeout |
| `CAMOFOX_VNC_RESOLUTION` | `1920x1080x24` | Virtual display resolution |
| `CAMOFOX_HEADLESS` | `true` | `true`/`false`/`virtual` display mode |
| `CAMOFOX_VNC_TIMEOUT_MS` | `120000` | Max VNC session duration |
| `CAMOFOX_VNC_BASE_PORT` | `6080` | noVNC/websockify base port |
| `CAMOFOX_VNC_HOST` | `localhost` | noVNC host in returned URL |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX` | `20` | Extended eval max requests per window |
| `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS` | `60000` | Extended eval rate-limit window |
| `CAMOFOX_SESSION_TIMEOUT` | `1800000` | Session idle timeout (min 60000) |
| `CAMOFOX_MAX_SESSIONS` | `50` | Max live sessions |
| `CAMOFOX_MAX_TABS` | `10` | Max tabs per session |
| `CAMOFOX_PRESETS_FILE` | unset | Custom presets JSON file |
| `CAMOFOX_DEFAULT_PRESET` | unset | Optional default preset name used for session locale/timezone/geolocation when no proxy is configured and no overrides are supplied; falls back to the first built-in preset if unset/invalid |
| `PROXY_HOST` | empty | Proxy host |
| `PROXY_PORT` | empty | Proxy port |
| `PROXY_USERNAME` | empty | Proxy username |
| `PROXY_PASSWORD` | empty | Proxy password |
| `CAMOFOX_CLI_USER` | `cli-default` | Default CLI user id |
| `CAMOFOX_IDLE_TIMEOUT_MS` | `1800000` | Idle timeout passed by CLI server manager |

## Project Structure

```text
.
├── AGENTS.md
├── README.md
├── bin/
│   └── camofox-browser.js
├── src/
│   ├── server.ts
│   ├── routes/
│   │   ├── core.ts
│   │   └── openclaw.ts
│   ├── cli/
│   │   ├── index.ts
│   │   ├── commands/
│   │   │   ├── core.ts
│   │   │   ├── navigation.ts
│   │   │   ├── interaction.ts
│   │   │   ├── content.ts
│   │   │   ├── session.ts
│   │   │   ├── auth.ts
│   │   │   ├── download.ts
│   │   │   ├── server.ts
│   │   │   ├── advanced.ts
│   │   │   ├── pipe.ts
│   │   │   ├── console.ts
│   │   │   └── trace.ts
│   │   ├── server/manager.ts
│   │   ├── vault/
│   │   └── transport/
│   ├── services/
│   │   ├── session.ts
│   │   ├── tab.ts
│   │   ├── context-pool.ts
│   │   ├── download.ts
│   │   ├── tracing.ts
│   │   └── vnc.ts
│   └── utils/
│       ├── config.ts
│       ├── macros.ts
│       └── presets.ts
├── plugin.ts
└── Dockerfile
```

## Key Files

- `src/cli/index.ts` — global CLI options, command registration, preAction auto-start behavior.
- `src/cli/commands/*.ts` — CLI command definitions and options.
- `src/routes/core.ts` — canonical REST endpoints used by CLI and API clients.
- `src/routes/openclaw.ts` — OpenClaw compatibility routes and action multiplexer.
- `src/utils/macros.ts` — all 14 macro names and expansion URLs.
- `src/utils/presets.ts` — built-in geo presets + custom preset loader.
- `src/utils/config.ts` — centralized environment parsing/defaults.
- `src/services/session.ts` — session limits/timeouts and tab indexing.
- `src/services/tracing.ts` — Playwright trace lifecycle and chunk management.
- `src/services/vnc.ts` — virtual display + noVNC lifecycle.
- `src/cli/vault/*` — encrypted auth vault implementation.
- `src/cli/server/manager.ts` — daemon lifecycle and health checks.
- `plugin.ts` — OpenClaw plugin integration layer.
