## v2.0.3 (2026-03-05)

### Bug Fixes
- **`fill` command**: Fixed ref format mismatch - bare refs (`e1`) now correctly sent to server instead of bracketed (`[e1]`)
- **`select` command**: Fixed fallback to use `selectOption()` instead of `fill()` for `<select>` elements; supports both value and label matching
- **`auth load --inject`**: Reimplemented credential injection using `/act` type calls instead of non-existent `/fill-form` endpoint

### Removed
- **`drag` command**: Removed dead code - no server endpoint existed for drag-and-drop

### Performance
- **Eliminated double HTTP requests**: All CLI commands now call correct endpoints directly, removing wasteful 404 fallback to `/api/*` paths

### Internal
- Deleted unused `api-fallback.ts` utility
- Added `case 'select'` handler to `/act` endpoint in openclaw.ts
- Cleaned up degenerate error handlers in health and downloads commands

## v2.0.2 (2026-03-05)

### Bug Fixes
- **CLI:** Fixed 8+ commands failing with "Forbidden" — HTTP transport now sends `Authorization: Bearer` header from `CAMOFOX_API_KEY` environment variable.
- **CLI:** Fixed CSS selector support in `click`, `type`, `select`, `hover` commands — selectors like `mat-icon[fonticon="download"]` now correctly route to server's selector path instead of being treated as refs.
- **CLI:** Fixed misleading help text — element ref notation corrected from `[e5]` to `e5`.

### New
- Added `src/cli/utils/selector.ts` — shared selector detection utility for element-targeting commands.

## v2.0.1 (2026-03-05)

### Bug Fixes
- **CLI:** Fixed fresh-install crash caused by `process.cwd()` failing when CWD lacks `package.json` (global installs). Now uses `__dirname`-relative path. (#10)
- **CLI:** Fixed stale-daemon reuse — `isRunning()` now validates server identity (`engine === 'camoufox'`), preventing connection to wrong services on port 9377.
- **Health:** Added `version` field to `/health` and OpenClaw `/` endpoints for runtime version verification.

### Documentation
- Comprehensive v2.0.0 documentation update: 17 new API routes, 3 CLI command groups, 12 environment variables documented.

## 🦊 CamoFox Browser Server v2.0.0

**Release Date:** 2026-03-03

### Highlights
- **🖥️ CLI Mode** — 50+ commands for terminal-based browser automation
- **🔐 Auth Vault** — AES-256-GCM encrypted credential storage (LLM-safe)
- **📜 Pipeline Scripting** — Execute command scripts from files
- **🔧 Session Management** — Save/load browser profiles with cookies
- **🔍 Console Capture** — Capture and filter browser console messages
- **📼 Playwright Tracing** — Record traces for debugging
- **📥 Download Management** — Track, export, batch-download page resources
- **🍪 Cookie Management** — Import/export cookies per tab

### Breaking Changes
- Node.js >=20 required (was >=18)
- New `engines.node` constraint in package.json

### Key New Features
- **CLI Tool**: Full browser automation from terminal — open, navigate, click, type, wait, eval, screenshot, snapshot, scroll, fill forms, press keys, search web
- **Auth Vault**: Store credentials encrypted at rest with AES-256-GCM. No plaintext passwords in command history or logs
- **Session Profiles**: Save/load browser state (cookies, local storage) for quick re-authentication
- **Pipeline Scripting**: Batch execute commands from `.camofox` script files with comment support
- **Console Capture**: `camofox console` and `camofox errors` to capture browser logs
- **Playwright Tracing**: `camofox trace start/stop` with chunk support for targeted debugging
- **Download Manager**: Track browser downloads, extract page resources, batch download, resolve blob URLs
- **Output Formatting**: `--format json` flag for machine-readable output across all commands

### Infrastructure
- Daemonized server management (`camofox server start/stop/status`)
- Auto-start daemon on first CLI command
- Server version exposed in `/health` endpoint
- Health monitoring with pool metrics

## 🦊 CamoFox Browser Server v1.0.0

### Highlights
- **Independent repo** — no longer a fork, full autonomy
- **Complete TypeScript rewrite** with strict mode
- **Modular architecture** — routes/services/middleware/utils
- **200MB lighter** — removed 3 unnecessary dependencies
- **Docker + CI/CD** — multi-stage build, GitHub Actions

### Changed
- Complete TypeScript rewrite with strict mode
- Modular architecture (routes/services/middleware/utils)
- Independent repo (no longer a fork)

### Added
- Geo preset system with 8 built-in presets
- Custom preset file support via CAMOFOX_PRESETS_FILE
- Docker multi-stage build with healthcheck
- GitHub Actions CI (lint/build/test on Node 20/22)
- GHCR Docker image publishing on release tags

### Removed
- Unused dependencies: playwright, playwright-extra, puppeteer-extra-plugin-stealth (~200MB)

### Fixed
- OpenClaw /snapshot ref annotation bug
- Jest open handle warnings
- Unused import/any type violations

### Credits
- [Camoufox](https://camoufox.com) — Firefox-based browser with anti-detection
- [OpenClaw](https://openclaw.ai) — compatibility endpoints
