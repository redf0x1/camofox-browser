# Changelog

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
