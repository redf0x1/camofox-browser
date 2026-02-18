# Changelog

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
