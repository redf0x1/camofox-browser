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
