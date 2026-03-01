# Changelog

## [1.9.0] - 2026-03-01

### Added
- `POST /tabs/:tabId/evaluate-extended` — Execute JavaScript with extended timeout up to 300 seconds
	- Configurable timeout (100ms to 300s, default 30s)
	- Conditional API key authentication (when `CAMOFOX_API_KEY` is set)
	- Per-user fixed-window rate limiting (default: 20 req/minute)
	- Environment variables: `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX`, `CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS`
- In-memory rate limiter middleware (`src/middleware/rate-limit.ts`)
- Unit tests for rate limiter and extended evaluator
- E2E tests for evaluate-extended endpoint

### Changed
- Refactored `evaluateTab()` to share internal logic via `_evaluateInternal()` — no behavior changes to existing `/evaluate` endpoint

### Fixed
- Restored missing `POST /sessions/:userId/toggle-display` route that was causing `Cannot POST` 404 errors from MCP toggle_display tool

## [1.8.1] — 2025-07-15

### Fixed
- **noVNC display scaling** — Removed x11vnc `-ncache` flag that caused 10x framebuffer height in noVNC viewer
- **Custom Xvfb resolution** — Replaced camoufox VirtualDisplay (1x1px) with custom Xvfb spawner at 1920x1080 resolution
- **`CAMOFOX_VNC_RESOLUTION`** — Configurable virtual display resolution (default: 1920x1080x24)

## [1.4.0] - 2026-02-18

### Added
- `withTimeout()` utility — configurable handler timeout (default 30s, env: `HANDLER_TIMEOUT_MS`)
- `withUserLimit()` — per-user concurrency limiter (default 3, env: `MAX_CONCURRENT_PER_USER`)
- `safePageClose()` — safe page close with 5s timeout, prevents hung close operations
- Unit tests for all new utility functions

### Changed
- ariaSnapshot timeout reduced 10s → 5s for faster failure detection
- ariaSnapshot retry now catches failures gracefully (returns empty refs instead of crashing)
- `getAriaSnapshot()` returns null on failure instead of throwing
- Navigate endpoint returns 400 (not 500) for blocked URL schemes
- All core handlers wrapped with `withTimeout` for request-level timeout protection
- Navigate, snapshot, click handlers wrapped with `withUserLimit` for per-user concurrency control
- OpenClaw /navigate, /act, /snapshot handlers wrapped with `withTimeout` + `withUserLimit`
- All page.close() calls replaced with `safePageClose()`
- userId validation added to navigate, snapshot, click endpoints (returns 400 if missing)

### Removed
- Dead code: unused `navigateTab()`, `scrollTab()`, `waitTab()` exports

### Security
- Blocked URL scheme detection returns proper 400 status code

## [1.3.0] - 2026-02-18

### Added
- **Persistent browser profiles**: Each userId gets a real Firefox profile directory that auto-persists ALL browser state (cookies, localStorage, IndexedDB, Service Workers, cache)
- New `CAMOFOX_PROFILES_DIR` environment variable for custom profile storage location (default: `~/.camofox/profiles`)
- Context pool manager with LRU eviction and eviction callbacks
- Health endpoint now reports pool stats (poolSize, activeUserIds, profileDirsTotal)

### Changed
- Browser contexts are now backed by persistent Firefox profile directories instead of ephemeral in-memory contexts
- Session management refactored to use context pool
- Removed singleton browser pattern in favor of per-user browser processes

### Fixed
- Telegram and other IndexedDB-based sites now maintain login sessions across restarts
- Session eviction properly cleans up tab references

## [1.2.0] - 2026-02-18

### Changed
- Cookie import, cookie export, and evaluate endpoints are now **open by default** when `CAMOFOX_API_KEY` is not set (previously returned 403).
- Authentication is enforced only when `CAMOFOX_API_KEY` is configured — API key is now an opt-in security layer.
- Added startup warning when running without API key for network-exposed deployments.

### Fixed
- `GET /health` now includes a `running` field for MCP `server_status` compatibility.

## [1.1.2] - 2026-02-16

### Fixed
- `GET /health` now includes a `running` field for MCP `server_status` compatibility.

## [1.1.1] - 2026-02-16

### Fixed
- Filling text into `contenteditable` elements now uses a keyboard-based replace to avoid doubled text in rich editors.

## [1.1.0] - 2026-02-16

### Added
- `POST /tabs/:tabId/scroll-element` — Scroll specific container elements (modals, sidebars, overflow divs) with `selector`/`ref`, `deltaY`/`deltaX`, or `scrollTo` positioning. Returns scroll position metadata.
- `POST /tabs/:tabId/evaluate` — Execute JavaScript expressions in page context (isolated scope). API key required. Supports timeout configuration, max 64KB expression, 1MB result cap.

### Notes
- `evaluate` endpoint runs in isolated scope, invisible to page scripts — safe for anti-detection.
- Element scrolling: use `selector: "html"` for page-level scrolling (not `"body"`).

## [1.0.1] - 2025-02-15

### Fixed
- Docker container /health returning 500 due to missing better-sqlite3 native bindings
- CLI --help/--version flags now work without starting the server

### Changed
- Dockerfile: added build tools (python3, make, g++) for native module compilation
- Dockerfile: removed --ignore-scripts from production npm install

## [1.0.0] - 2026-02-15

### Changed
- Complete TypeScript rewrite with strict mode
- Modular architecture (routes/services/middleware/utils)
- Independent repo (no longer a fork)

### Added
- Geo preset system with 8 built-in presets (us-east, us-west, japan, uk, germany, vietnam, singapore, australia)
- Custom preset file support via CAMOFOX_PRESETS_FILE
- Composite session keys for multi-context support
- Tab session index for cross-session tab lookup

### Removed
- Unused dependencies (playwright, playwright-extra, puppeteer-extra-plugin-stealth)
- ~200MB dependency weight reduction

### Fixed
- OpenClaw /snapshot ref annotation bug (now uses shared helper)
- Session cleanup with prefix-based matching
