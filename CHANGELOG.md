# Changelog

## [1.5.1] - 2026-02-20

### Fixed
- Dockerfile: Added `VOLUME /home/node/.camofox` to make persistence intent explicit
- fly.toml: Added `CAMOFOX_PROFILES_DIR`, `CAMOFOX_COOKIES_DIR`, `CAMOFOX_DOWNLOADS_DIR` env vars for Fly.io volume persistence

### Added
- docker-compose.yml for easy deployment with volume mount

### Docs
- Updated Docker examples in README.md and AGENTS.md with volume mount

## [1.5.0] - 2025-02-20

### Added
- Download lifecycle management (register, list, get, delete, cleanup with TTL)
- Scoped DOM resource extraction (images, links, media, documents from specific containers)
- Batch download pipeline with concurrency control and semaphore
- Blob URL resolution for Firefox (FileReader.readAsDataURL pattern)
- Enhanced `GET /links` with scope, extension, and downloadOnly filters
- 8 new REST endpoints for downloads and resource management
- Per-user download cap (500 entries) with LRU eviction
- Stream error handling on download content delivery
- Data URI support (both base64 and URL-encoded)
- Comprehensive unit tests for download helpers, registry, and batch downloader

### Fixed
- Resolve-blobs endpoint now capped at 25 URLs with parallel resolution
- Batch-download timeout increased to 5 minutes
- Cleanup interval skips pending downloads
- Error responses standardized with safeError() across all new endpoints

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
