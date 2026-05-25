# Changelog

## [Unreleased]

## [2.4.5] - 2026-05-25

### Added
- Added `CAMOFOX_AUTH_MODE=auto|required|disabled` to make API-key enforcement explicit: `auto` preserves secure defaults, `required` enforces bearer auth on every bind, and `disabled` supports trusted private agent networks whose clients cannot send bearer tokens.

### Security
- `CAMOFOX_AUTH_MODE=disabled` now permits non-loopback binds without `CAMOFOX_API_KEY` only while keeping private-network navigation blocked; startup fails if disabled auth is combined with `CAMOFOX_ALLOW_PRIVATE_NETWORK=true` on non-loopback binds.

### Tests
- Added unit and E2E coverage for auth-mode parsing, required-mode startup failure, disabled-mode network bind compatibility, and disabled-mode private-network guardrails.

## [2.4.4] - 2026-05-23

### Fixed
- First tab creation now reuses the browser engine's initial untracked `about:blank` page when safe, preventing headed and virtual-display sessions from opening an extra empty window beside the requested page.

### Security
- Refreshed Express/body-parser/qs and CI reporter dependency locks so `npm audit --audit-level=moderate` reports zero vulnerabilities.

### Tests
- Added unit and real browser regression coverage for the first-tab initial blank-page reuse path.

## [2.4.3] - 2026-05-13

### Fixed
- Session-level `proxyProfile` and raw `proxy` settings now reach the browser context launch path, so proxy egress intent is applied instead of only being validated/stored.
- Session-profile contexts now use delimiter-safe runtime keys derived from `userId + sessionKey + profile signature` and profile-keyed persistent directories, preventing sibling proxy profiles for the same user from sharing one browser context or `userDataDir`.
- Session/user ownership checks no longer use raw `userId::sessionKey` prefix matching, so `userId` or `sessionKey` values containing `::` cannot collide with another user's sessions, tab index, or cleanup path.
- First-create rollback now closes staged profile-keyed contexts by user/generation and always releases the canonical mutex, so a failed proxy-profile first tab cannot wedge future retries.
- Rejected core/OpenClaw requests no longer persist provisional session proxy profiles or leave allocated profile-key sessions/contexts behind after runtime allocation failures.
- Concurrent core/OpenClaw requests for the same new session profile now wait for the profile-create attempt to commit or rollback, so a failed creator cannot delete a sibling request that already returned success.
- Idle lifecycle cleanup now closes and removes only the exact zero-tab profile-key session, preserving active sibling profile sessions for the same user.
- Display-mode toggles now prewarm the existing single profile-key context for VNC with its profile launch settings while avoiding stale default-context prelaunches before first tab create.
- Cookie import now rejects ambiguous user-level requests when multiple active browser contexts exist, requiring `tabId` targeting instead of importing into an arbitrary sibling context.
- Eviction, timeout, and shutdown cleanup now resolve encoded session/profile keys back to their raw owner user IDs for trace/download/VNC cleanup.
- Internal session/profile/trace ownership tokens now preserve UTF-16 code-unit identity, so malformed Unicode user/session IDs cannot collapse into replacement-character aliases or cross profile/trace ownership boundaries.
- Legacy UTF-8 trace artifact lookup now accepts only collision-free owner tokens, so a crafted user ID cannot use a legacy token that is also another user's UTF-16LE artifact token.
- Explicit session close now treats `userId` as an external owner ID only, so raw internal `u:`, `o:`, or `p:` session/profile keys cannot close another user's runtime state through `/sessions/:userId`.
- Default profile directory compatibility now applies only to well-formed non-internal user IDs; raw IDs that look like internal `u:`, `s:`, `p:`, or `o:` keys, or contain malformed UTF-16, remain isolated under encoded profile-key directories.

## [2.4.2] - 2026-05-13

### Fixed
- `proxyProfile` now takes precedence over raw `proxy` when both are supplied for session proxy/geo resolution, matching the documented/tested contract for `/tabs` and `/tabs/open`.
- Refreshed runtime and dev dependency lockfile entries so full `npm audit` reports zero vulnerabilities.

## Release Audit: v2.3.0 -> v2.4.1

### What shipped in this line
- **Security hardening** tightened exposed deployment defaults with loopback-only bind, non-loopback API key enforcement, private-network navigation blocking, and fail-fast proxy deployment validation.
- **Proxy and geo session identity** moved from user-only scoping to `userId + sessionKey`, allowing parallel sessions with distinct proxy and geo profiles without unsafe reuse or eviction collisions.
- **Lifecycle control** added staged idle cleanup plus daemon exit policy, with activity-aware timer disarming so live sessions are not collected accidentally.
- **Fingerprint environment controls** added deployment-level defaults for OS, WebGL, screen dimensions, and humanization, with strict parsing and clear generation-time versus launch-time behavior.
- **Structured extraction** introduced schema-driven extraction across core API, CLI, and OpenClaw, including validation-time 400s and runtime 422s with stable field-path reporting.
- **OpenAPI and interactive docs** added `/openapi.json` and `/api/docs`, then hardened the spec and origin handling to match real server behavior.
- **Release-lane hardening** shipped in `v2.4.1`, ensuring Docker/GHCR publication no longer fails solely because optional GeoLite download during `camoufox-js fetch` is temporarily unavailable.

### Reading guide
- **`2.4.0`** is the main Wave 2 delivery release.
- **`2.4.1`** is the follow-up patch that fixes the release-distribution lane while inheriting the full `2.4.0` surface.

## [2.4.1] - 2026-05-05

### Upgrade Notes
- **Patch scope**: `2.4.1` keeps the full Wave 2 surface from `2.4.0` and only changes release-distribution behavior.
- **Operator impact**: Docker/GHCR publication no longer fails solely because `camoufox-js fetch` cannot download the optional GeoLite database during image build.

### Fixed
- **Docker release builds** now tolerate transient `camoufox-js fetch` / GeoLite MMDB download failures during image creation.
- **Release-lane consistency** now matches the existing best-effort `postinstall` fetch contract already used by package installation.

## [2.4.0] - 2026-05-05

### Upgrade Notes
- **Wave 2 delivery** adds OpenAPI documentation, deployment-level fingerprint controls, staged idle lifecycle management, session-level proxy/geo overrides, and structured extraction without removing previous route aliases.
- **Operational posture** is more defensive than in `2.3.0`: exposed deployments now default to loopback-only binding, require an API key on non-loopback binds, reject unsafe private-network navigation by default, and fail fast on unsupported proxy deployment assumptions.

### Added
- **OpenAPI 3.1.0 specification** at `/openapi.json` with request/response schemas, auth requirements, and representative route coverage.
- **Interactive Swagger UI** at `/api/docs` for live inspection and request testing.
- **Fingerprint environment controls** for `CAMOFOX_OS`, `CAMOFOX_ALLOW_WEBGL`, `CAMOFOX_SCREEN_WIDTH`, `CAMOFOX_SCREEN_HEIGHT`, and `CAMOFOX_HUMANIZE`.
- **Idle lifecycle policy** with staged cleanup (`CAMOFOX_IDLE_TIMEOUT_MS`) and daemon exit (`CAMOFOX_IDLE_EXIT_TIMEOUT_MS`).
- **Session-level proxy/geo overrides** through `proxyProfile`, raw `proxy` fields, and `geoMode`.
- **OpenClaw proxy/geo parity** for `/tabs/open`.
- **Structured extraction** across core API, CLI, and OpenClaw with schema validation and deterministic JSON output.

### Changed
- **Session identity and reuse** now key proxy/geo behavior on `userId + sessionKey` instead of `userId` alone.
- **Context pool eviction** now uses `profileKey`, preventing sibling sessions from evicting each other incorrectly.
- **OpenAPI docs behavior** now derives server origin from the incoming request and safe defaults instead of assuming a single static external origin.

### Fixed
- **Proxy profile validation** now rejects malformed configuration and preserves conflict behavior when an existing session profile disagrees with new proxy/geo input.
- **Lifecycle cleanup correctness** now avoids cleanup reentry, preserves reused/live contexts, and only arms daemon exit under valid idle conditions.
- **Fingerprint env application** now routes screen constraints into fingerprint generation rather than launch-only options, preserving the intended sidecar semantics.
- **Structured extraction contracts** now reject invalid root schemas/selectors and align API, CLI, and OpenClaw error semantics.
- **OpenAPI request contracts** now mark required fields correctly and remove mismatched schema claims such as unsupported `/act` coverage.

### Security
- Default server bind is `127.0.0.1` via `CAMOFOX_HOST`, and non-loopback binds require `CAMOFOX_API_KEY`.
- Navigation target validation blocks loopback/private/link-local/metadata hosts by default on exposed deployments unless `CAMOFOX_ALLOW_PRIVATE_NETWORK=true`.
- Proxy-enabled exposed deployments fail fast unless the operator explicitly opts into private-network allowance.

### Docs
- README, skills, and agent-facing references were updated to document the shipped Wave 2 surfaces.
- OpenAPI discovery wording, subset-scope wording, request contracts, and origin handling were corrected to match actual shipped behavior.

### Tests
- Added E2E coverage for security hardening, proxy/geo overrides, OpenClaw proxy/geo support, fingerprint env controls, lifecycle cleanup/exit, OpenAPI docs, and structured extraction.
- Added unit coverage for profile-key eviction, lifecycle state handling, proxy profile parsing, structured extractor schema/runtime contracts, and URL security validation.

## [2.3.0] - 2026-05-03

### Upgrade Notes
- **New Wave 1 surfaces** add trace artifact retrieval and image-only extraction on top of the existing tracing/resource services. These are additive endpoints and do not remove any previous route or alias.
- **Conditional auth coverage** now includes the image listing route when `CAMOFOX_API_KEY` is set, aligning it with the surrounding extraction/tracing surfaces.

### Added
- **Trace artifact management** — `GET /sessions/:userId/traces`, `GET /sessions/:userId/traces/:filename`, and `DELETE /sessions/:userId/traces/:filename`
- **Image listing route** — `GET /tabs/:tabId/images` for image-only extraction with selector, extension, blob-resolution, and lazy-load options
- **Wave 1 regression coverage** for trace ownership/path handling, timeout cleanup, chunk-stop coordination, and image-route auth/behavior

### Fixed
- Trace artifact ownership now uses collision-safe owner tokens rather than lossy userId sanitization
- Trace artifact handling now rejects spoofed paths, keeps managed files inside the traces root, and tolerates vanished files during list operations
- Trace timeout cleanup now stays coordinated with both manual stop and in-flight chunk-stop operations
- `extractImages()` no longer requires a fake `userId` shim in its shared extractor contract

### Changed
- README and release metadata now reflect shipped Wave 1 trace/image capabilities
- Package and OpenClaw plugin versions now advance together to `2.3.0`

## [2.2.1] - 2026-04-09

### Changed
- Version bump for release-prep (v2.2.0 tag exists; this patch carries final release framing)

## [2.2.0] - 2026-04-09

### Upgrade Notes
- **Local-state sidecar versioning** introduces fail-closed compatibility checks. If local state files are incompatible with the running version, the server will refuse to start the affected session and log an error with the specific path to delete. For sidecar metadata files, only the indicated file needs removal. For profile-level incompatibilities (e.g., Camoufox engine version mismatch), the error may indicate deleting the entire profile directory — follow the error message guidance.
- **API key guard** is now conditionally applied to core and OpenClaw protected endpoints (tab creation, navigation, interaction, session management, downloads, tracing, console) when `CAMOFOX_API_KEY` is set. The `POST /stop` route requires `CAMOFOX_ADMIN_KEY` unconditionally. Unset deployments are unaffected.

### Added
- **Conditional API-key guard** (`CAMOFOX_API_KEY`) on core and OpenClaw protected endpoints — tab creation, navigation, interaction, session management, downloads, tracing, console. Guard enforced only when env var is set; unset deployments are unaffected. `POST /stop` uses a separate unconditional `CAMOFOX_ADMIN_KEY` guard
- **Canonical profile invariants** — staged first-use, rollback-on-failure, cookie race guard
- **Local-state sidecar versioning** with fail-closed compatibility checks and migration support
- **Snapshot pagination** with offset-based windowing for large page snapshots
- **OpenClaw parity** — snapshot, navigate, scroll endpoints aligned with plugin contract
- **Macro navigate** and scroll parity with initial-download capture
- **Plugin surface cleanup** — publish/install/plugin artifact contract validation

### Fixed
- Server env whitelist: added `DISPLAY`, `HANDLER_TIMEOUT_MS`, `MAX_CONCURRENT_PER_USER`
- Unified CLI port and idle-timeout defaults with canonical config
- Session lifecycle: staged first-use + rollback, cookie race guard, dist rebuild, tab-cap test

### Changed
- README, skills, and governance docs synced to shipped behavior

## [2.1.1] - 2026-03-08

### Fixed
- Unknown element ref now returns HTTP 400 with guidance message instead of ambiguous error

## [2.1.0] - 2026-03-08

### Fixed
- **Ref system improvements** — strict ref parsing, expanded element roles in snapshot, stale ref detection

## [2.0.5] - 2026-03-08

### Fixed
- Resolved text input truncation at ~500 characters caused by humanize typing delay + 30s handler timeout
- `smartFill()` now uses bulk DOM insertion via `page.evaluate()` for text >= 400 characters
- Dynamic typing timeout replaces fixed 30s limit: 10,000ms base + 80ms per character (max 120,000ms)

### Changed
- Short text (<400 chars) continues to use humanized per-character typing for anti-detection
- ContentEditable elements use `document.execCommand('insertText')` for rich text compatibility

## [2.0.0] — 2026-03-03

### ✨ Added
- **CLI Mode**: 47+ commands for terminal-based browser automation (`camofox` command)
- **Auth Vault**: AES-256-GCM encrypted credential storage with Argon2id KDF
	- `auth save/load/list/delete/change-password` commands
	- Credentials never output to stdout (LLM-safe)
	- Optional `argon2` dependency with PBKDF2 fallback
- **Session Management**: Save/load/list/delete browser sessions via CLI
- **Cookie Management**: Export/import cookies via CLI
- **Pipeline Scripting**: Execute command scripts from files (`camofox run script.txt`)
- **Output Formatting**: JSON, text, and plain output formats (`--format`)
- **Server Management**: Start/stop/status commands for daemon lifecycle
- **Advanced Commands**: `annotate`, `health`, `version`, `info`
- **Auto Server Start**: CLI automatically starts server when needed
- **Search Macros via CLI**: 14 search engines supported (`camofox search "query" --engine google`)

### 🔧 Changed
- Node.js minimum version updated to >=20 (from >=18)
- Added `camofox` bin entry alongside existing `camofox-browser`
- Added `commander` as direct dependency (v14.0.3)
- Added `argon2` as optional dependency

### 🏗️ Architecture
- HTTP-only transport with lazy server start (daemon pattern)
- PID file management at `~/.camofox/`
- Atomic file writes for session and vault data
- API fallback pattern for backward compatibility with older server versions

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
- Documentation clarification: async expressions for `/evaluate` and `/evaluate-extended` must be wrapped in an async IIFE (`(async () => { ... })()`), since top-level `await` is not supported by `page.evaluate()`

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
