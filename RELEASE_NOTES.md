# Release Notes

## Preview Governance

CamoFox Browser Server is in **Preview** (Phase 1). See [Preview Status](README.md#preview-status) in README for commitments and non-goals.

**Release gates** are evidence-bound: every tagged release must pass the [Release Gate Checklist](CONTRIBUTING.md#release-gate-checklist) in CONTRIBUTING.md before publication. Claims in README, RELEASE_NOTES, and CHANGELOG must reflect audited, shipped behavior — not unshipped plans.

**Preview-to-GA evaluation** is evidence-based, not calendar-based. Promotion will be assessed against criteria including API surface stability, proven local-state versioning across format changes, passing test suites on supported Node.js versions, and resolution of all preview-blocking issues. These criteria may be refined as the project matures.

---

## Version Provenance (v2.0.5+)

| Version | Commit | npm | GitHub Release | Notes |
|---------|--------|-----|----------------|-------|
| v2.4.5 | — | Published 2026-05-25 | Published | Patch release: adds `CAMOFOX_AUTH_MODE=auto|required|disabled` so trusted private agent networks can explicitly disable API-key auth for clients such as Hermes/OpenClaw/GoClaw that cannot send bearer tokens, while preserving secure `auto` defaults and fail-fast guardrails for unsafe disabled-auth private-network exposure. Resolves [#20](https://github.com/redf0x1/camofox-browser/issues/20). |
| v2.4.4 | — | Published 2026-05-23 | Published | Patch release: reuses the browser engine's initial untracked `about:blank` page for the first managed tab when safe, preventing headed and virtual-display sessions from opening an extra empty window beside the requested page. Also refreshes dependency locks so `npm audit --audit-level=moderate` reports zero vulnerabilities. |
| v2.4.3 | `7a9c96f` | Published 2026-05-14 | Published | Patch release: applies session-level proxy profiles to browser context launch, isolates sibling profile sessions by delimiter-safe profile-keyed persistent directories, preserves UTF-16 identity for session/profile/trace ownership tokens, rejects colliding legacy trace owner tokens, prevents raw internal session/profile keys from closing another user's runtime state, fixes staged first-create rollback, prevents stale rejected profile/runtime state and profile-create rollback races, corrects profile-key idle/display/shutdown cleanup, preserves VNC prewarm with existing profile launch settings, and rejects ambiguous user-level cookie imports. |
| v2.4.2 | `b707e8b` | Not published | Tag only | Superseded before npm/GitHub release by `v2.4.3` after final proxy-egress review found the launch wiring gap. |
| v2.4.1 | `607423f` | Published 2026-05-05 | Published | Patch release: hardens Docker/GHCR publication against transient GeoLite download failures during `camoufox-js fetch`. |
| v2.4.0 | `700ea55` | — | Published | Wave 2 release candidate. Adds OpenAPI specification, interactive API docs, server-wide fingerprint controls, idle lifecycle policies, session-level proxy/geo overrides, and structured extraction. |
| v2.3.0 | — | — | — | Wave 1 release candidate. Adds trace artifact management and image-only extraction, with refreshed release metadata. |
| v2.2.1 | — | — | — | Release-ready. Carries final release framing over v2.2.0 tag. |
| v2.2.0 | `e2c397d` | — | — | Tagged 2026-04-09. Includes 11 feature commits since v2.1.1. |
| v2.1.1 | `8b97952` | Published 2026-03-08 | Published | Patch: ref error handling |
| v2.1.0 | `ea5af9d` | Published 2026-03-08 | Published | Patch: ref system improvements |
| v2.0.5 | `e696846` | Published 2026-03-08 | Published | Patch: typing truncation fix |

> **Upgrade guidance for v2.4.5+:** `v2.4.5` keeps the full `v2.4.4` behavior and adds explicit API-key policy control through `CAMOFOX_AUTH_MODE=auto|required|disabled`. Use `auto` for the existing secure default: loopback can run without a key, while non-loopback binds require `CAMOFOX_API_KEY`. Use `required` when every bind, including loopback, must fail without a key. Use `disabled` only on trusted private agent networks whose clients cannot send bearer tokens; it must be run without `CAMOFOX_API_KEY`, allows non-loopback binds without bearer auth, and fails startup if combined with `CAMOFOX_ALLOW_PRIVATE_NETWORK=true` on a non-loopback bind. `v2.4.4` keeps the full Wave 2 surface from `v2.4.0`, retains the `v2.4.1` release-lane hardening fix, includes the `v2.4.3` session/profile/trace ownership and proxy-egress fixes, and prevents first-tab creation from leaving an extra engine-created `about:blank` page open in headed or virtual-display sessions. `v2.4.3` corrected session proxy/geo precedence so a named `proxyProfile` wins when both `proxyProfile` and raw `proxy` are supplied, applied the resolved proxy to browser context launch, isolated sibling profile sessions by delimiter-safe profile-keyed persistent directories, preserved UTF-16 code-unit identity in session/profile/trace ownership tokens, rejected legacy UTF-8 trace artifact tokens that can collide with another user's UTF-16LE owner token, kept legacy default profile directories only for well-formed non-internal user IDs, closed staged profile-keyed contexts during first-create rollback, cleared provisional session profiles and allocated profile-key runtimes from rejected requests, serialized concurrent profile-create attempts until commit or rollback, cleaned idle profile-key sessions without closing active siblings, avoided raw delimiter matching for session/user ownership, treated explicit session-close `userId` values as external owner IDs rather than raw internal session/profile keys, avoided stale default-context prelaunches after display-mode toggles while preserving VNC prewarm for an existing single profile-key context with its launch settings, rejected ambiguous user-level cookie imports when multiple browser contexts exist unless `tabId` targets the intended context, and resolved encoded cleanup keys back to owner user IDs for trace/download/VNC cleanup. Wave 2 also introduces OpenAPI documentation at `/openapi.json` and `/api/docs`, server-wide fingerprint environment controls (`CAMOFOX_OS`, `CAMOFOX_ALLOW_WEBGL`, `CAMOFOX_SCREEN_WIDTH`, `CAMOFOX_SCREEN_HEIGHT`, `CAMOFOX_HUMANIZE`), idle lifecycle policies (`CAMOFOX_IDLE_TIMEOUT_MS`, `CAMOFOX_IDLE_EXIT_TIMEOUT_MS`), session-level proxy/geo overrides via `proxyProfile` or raw `proxy` fields, hybrid geo modes (`explicit-wins` vs `proxy-locked`), and structured extraction with schema validation. Security defaults now include loopback-only binding (`CAMOFOX_HOST=127.0.0.1`), `auto` non-loopback API key requirement, navigation target validation blocking private/loopback hosts unless `CAMOFOX_ALLOW_PRIVATE_NETWORK=true`, and fail-fast proxy deployment validation. Local-state sidecar versioning remains fail-closed — incompatible state causes the affected session to error with the specific path to delete. When API-key auth is active, core and OpenClaw protected endpoints require `Authorization: Bearer` auth; `POST /stop` requires `CAMOFOX_ADMIN_KEY` unconditionally.

> **Note:** A 2.1.x maintenance lane would only be opened if a user-facing defect in published v2.1.1 requires hotfix maintenance. Current development continues on the 2.4.5+ line.

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
