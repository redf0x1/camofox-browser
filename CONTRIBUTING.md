# Contributing to CamoFox Browser Server

## Development Setup

1. Clone: `git clone https://github.com/redf0x1/camofox-browser.git`
2. Install: `npm install`
3. Build: `npm run build`
4. Dev mode: `npm run dev` (hot reload with `tsx`)
5. Test: `npm test`
6. Lint: `npm run lint`

Install requires Python 3 on Linux, or the system `tar` on macOS/Windows, for
disk-backed browser extraction. For source-only checks, set
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` during dependency installation, then unset it
and run `npm run browser:install` before browser tests. See README for cache recovery;
never delete profiles to repair a missing engine.

## Project Structure

- `src/server.ts` — Express server entrypoint
- `src/routes/` — REST endpoints (core + OpenClaw compatibility)
- `src/services/` — Browser/session/tab logic
- `src/middleware/` — logging + auth + error handling
- `src/utils/` — config, cookies, presets, macros
- `tests/` — Jest tests (includes optional live tests)
- `plugin.ts` — OpenClaw plugin wrapper

## Pull Request Process

1. Create a feature branch
2. Make focused changes with tests where appropriate
3. Ensure `npm run lint` and `npm test` pass
4. Submit a PR with a clear description and repro steps (when applicable)

## Environment Variable Security

**Do not pass the host environment to child processes.**

When spawning child processes (e.g., launching the server from the OpenClaw plugin), only pass an explicit whitelist of environment variables. Never use `...process.env` or equivalent spreads.

```ts
// WRONG — leaks all host secrets to the child process
spawn('node', [serverPath], {
  env: { ...process.env, CAMOFOX_PORT: '9377' },
});

// RIGHT — only what the child actually needs
spawn('node', [serverPath], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
    CAMOFOX_PORT: '9377',
  },
});
```

If the child process needs a new env var, add it to the whitelist explicitly (do not broaden the whitelist).

**Do not use `dotenv` or load `.env` files.** The server reads configuration from explicitly passed environment variables only.

## Preview Compatibility Rules

CamoFox is in Preview (Phase 1). These rules apply to all contributions during this period.

### Adding New Endpoints or Commands
- New endpoints and CLI commands may be added freely
- Document them in CHANGELOG.md under the appropriate version

### Renaming or Moving Endpoints
- Maintain the old path as an alias that routes to the new implementation
- Mark the alias as deprecated in code comments and CHANGELOG
- Do NOT remove the alias until GA or a documented migration window

### Renaming Request/Response Fields
- Accept both old and new field names in request bodies
- Emit only the new field name in responses
- Document the rename in CHANGELOG

### Local State Format Changes
- Use the versioned sidecar pattern (`readVersionedSidecar` / `writeVersionedSidecar` from `src/utils/sidecar-version.ts`)
- Add a read path for the previous version format
- Fail closed on unknown, corrupt, or newer-than-expected state — log an actionable error, never silently regenerate or auto-migrate

## Release Gate Checklist

Before tagging a release, verify each item against the current codebase — not prior documentation:

- [ ] Every feature claim in README matches shipped, tested behavior
- [ ] CLI command count and search macro count match registered implementations
- [ ] Environment variable table in README matches actual code defaults in `src/utils/config.ts`
- [ ] CHANGELOG entry covers all changes since the last tag
- [ ] No unshipped or experimental features are described as stable
- [ ] Local state format changes (if any) include versioned read paths and are documented in CHANGELOG
- [ ] Breaking changes (if any) include recovery instructions in CHANGELOG and RELEASE_NOTES
