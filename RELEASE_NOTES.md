# Release Notes

## Preview Governance

CamoFox Browser Server is in **Preview** (Phase 1). See [Preview Status](README.md#preview-status) in README for commitments and non-goals.

**Release gates** are evidence-bound: every tagged release must pass the [Release Gate Checklist](CONTRIBUTING.md#release-gate-checklist) in CONTRIBUTING.md before publication. Claims in README, RELEASE_NOTES, and CHANGELOG must reflect audited, shipped behavior — not unshipped plans.

**Preview-to-GA evaluation** is evidence-based, not calendar-based. Promotion will be assessed against criteria including API surface stability, proven local-state versioning across format changes, passing test suites on supported Node.js versions, and resolution of all preview-blocking issues. These criteria may be refined as the project matures.

---

## Version Provenance (v2.0.5+)

| Version | Commit | npm | GitHub Release | Notes |
|---------|--------|-----|----------------|-------|
| v2.3.0 | — | — | — | Wave 1 release candidate. Adds trace artifact management and image-only extraction, with refreshed release metadata. |
| v2.2.1 | — | — | — | Release-ready. Carries final release framing over v2.2.0 tag. |
| v2.2.0 | `e2c397d` | — | — | Tagged 2026-04-09. Includes 11 feature commits since v2.1.1. |
| v2.1.1 | `8b97952` | Published 2026-03-08 | Published | Patch: ref error handling |
| v2.1.0 | `ea5af9d` | Published 2026-03-08 | Published | Patch: ref system improvements |
| v2.0.5 | `e696846` | Published 2026-03-08 | Published | Patch: typing truncation fix |

> **Upgrade guidance for v2.3.0+:** Local-state sidecar versioning is fail-closed — incompatible state causes the affected session to error with the specific path to delete. For sidecar metadata, only the indicated file is removed; for profile-level incompatibilities (e.g., engine version mismatch), the entire profile directory may need deletion. Follow the error message guidance. When `CAMOFOX_API_KEY` is set, core and OpenClaw protected endpoints require `Authorization: Bearer` auth; `POST /stop` requires `CAMOFOX_ADMIN_KEY` unconditionally. Current mainline hardening also defaults `CAMOFOX_HOST` to `127.0.0.1`, requires `CAMOFOX_API_KEY` for non-loopback binds, blocks private-network navigation targets on exposed deployments unless `CAMOFOX_ALLOW_PRIVATE_NETWORK=true`, and refuses proxy-enabled exposed binds unless that override is explicit.

> **Note:** A 2.1.x maintenance lane would only be opened if a user-facing defect in published v2.1.1 requires hotfix maintenance. Current development continues on the 2.3.0+ line.

> Earlier versions (v2.0.4 and below) are documented in individual release entries below. Note: v2.0.3 was reserved on npm; its content was published as v2.0.4.

---

### v2.1.1 — Ref Error Handling (2026-03-08)

**Bug Fixes:**
- Unknown element ref now returns HTTP 400 with a guidance message instead of an ambiguous error

### v2.1.0 — Ref System Improvements (2026-03-08)

**Bug Fixes:**
- **Ref system** — strict ref parsing, expanded element roles in snapshot, stale ref detection

### v2.0.5 — Typing Truncation Fix (2026-03-08)

**Bug Fixes:**
- Resolved text input truncation at ~500 characters caused by humanize typing delay + 30s handler timeout
- `smartFill()` now uses bulk DOM insertion for text >= 400 characters
- Dynamic typing timeout replaces fixed 30s limit

### v2.0.3 — CLI Bug Fixes & Cleanup (2026-03-05)
**npm:** Published as v2.0.4 (v2.0.3 reserved on npm registry)

**Bug Fixes:**
- **fill command**: Fixed ref format mismatch - now sends bare refs (`e1`) instead of bracketed (`[e1]`)
- **select command**: Fixed to use Playwright's `selectOption()` instead of `fill()`, supports both value and label matching
- **drag command**: Removed dead command (no server endpoint existed)
- **auth load --inject**: Reimplemented form injection via `/act` endpoint
- **Double HTTP requests**: Eliminated redundant `/api/*` fallback pattern across all CLI commands

**Cleanup:**
- Deleted orphaned `api-fallback.ts` utility
- Cleaned dead catch blocks in health and downloads commands

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
