# CamoFox Coding Conventions

This file defines code style and implementation conventions.
Tooling workflow instructions belong in `AGENTS.md`.

## Language & Framework Style
- Use TypeScript with `strict` settings enabled.
- Keep runtime target aligned with Node.js 22+.
- Use Express route handlers with explicit request/response typings.
- Use Commander.js for CLI command registration.
- Use Jest for tests and test naming consistency.
- Prefer small pure helpers for parsing/validation logic.

## Naming Conventions
- Files: kebab-case for modules (example: `session-resolver.ts`).
- Variables/functions: camelCase (`resolveTabId`, `userId`).
- Types/interfaces: PascalCase (`CliContext`, `ContextOverrides`).
- Enums/union aliases: PascalCase (`SearchEngine`).
- Constants: UPPER_SNAKE_CASE for true constants (`MAX_TABS_PER_SESSION`).
- Route paths: lowercase, hyphenated segments (`/toggle-display`).
- CLI commands: kebab-case verbs/nouns (`go-back`, `get-links`, `change-password`).

## Project Structure
```text
src/
  cli/
    commands/
    output/
    server/
    transport/
    utils/
    vault/
  middleware/
  routes/
  services/
  utils/
  types.ts
```
- Keep route wiring in `src/routes/*`.
- Keep browser/session behavior in `src/services/*`.
- Keep shared parser/config helpers in `src/utils/*`.
- Keep CLI-only helpers under `src/cli/*`.

## API Response Pattern
- Success responses should be consistent and JSON serializable.
- Prefer action responses with `ok: true` plus minimal payload.
- Error responses should use `ok: false` where established, or `{ error: message }` in legacy-compatible paths.
- Do not leak stack traces or secrets in API errors.

## CLI Output Pattern
Support three output formats consistently:
- `json`: machine-parseable structured JSON.
- `text`: human-friendly labeled output.
- `plain`: raw value/string for piping.

Command handlers should:
- Use shared formatter utilities.
- Return stable keys in JSON output.
- Avoid writing extra logs to stdout in `json`/`plain` mode.

## Security Rules
- Never log credentials, tokens, or decrypted vault secrets.
- Keep auth-vault and secret files with restrictive permissions.
- Validate untrusted input (URL, selector, refs, timeouts, file paths).
- Enforce request size/time limits on expression/eval-style endpoints.
- Respect API key gates where configured.
- Sanitize headers/content-disposition and user-provided file names.

## Testing Approach
- Add focused unit tests for parser/validator helpers.
- Add route-level tests for success and failure paths.
- Add CLI tests for command argument parsing and output format behavior.
- Cover fallback behavior (new API path -> legacy alias) when relevant.
- Prefer deterministic fixtures over network-dependent assertions.
- Keep tests isolated by user/session identity.

## Compatibility & Deprecation

### During Preview (Phase 1)
- Aliases are additive-only: old names continue working alongside new names.
- Sidecar files use versioned envelopes — see `src/utils/sidecar-version.ts`.
- On incompatible local state: throw with actionable error message, never silently regenerate or ignore.
- On deprecated field in request: accept silently, use the canonical field internally.
- On deprecated endpoint: route to the canonical implementation, do not duplicate logic.

### Alias Removal Criteria (Post-Preview)
- At least one major version with deprecation notice in CHANGELOG.
- GA readiness review approves removal with documented migration path.
