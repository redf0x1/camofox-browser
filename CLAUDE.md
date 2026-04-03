# CLAUDE.md — CamoFox Model Hints

## What CamoFox Is
CamoFox is a TypeScript browser automation server + CLI over the Camoufox anti-detection engine. Primary loop is ref-driven automation from accessibility snapshots, not selector-guessing.

## Key Context
- Default server URL: `http://localhost:9377`
- Default port envs: `CAMOFOX_PORT` / `PORT` (typically 9377)
 - Default preset env var: `CAMOFOX_DEFAULT_PRESET` (optional) — when set and no proxy is configured, this preset's locale/timezone/geolocation are used for new sessions if the caller provides no overrides.
- Core identity fields: `userId`, `tabId`, `sessionKey` (or legacy `listItemId`)
- Refs come from snapshot as `eN`-style element references

## When Writing Automation (follow all)
1. Use snapshot-first: open/navigate -> snapshot -> interact -> snapshot.
2. Interact by refs first (`click/type/fill/press`), selectors only if needed.
3. Always include user scope (`--user` in CLI or `userId` in API body/query).
4. Use `--format json` for machine-consumed outputs.
5. Use auth vault + `auth load --inject` for credentials; never expose secrets.

## When Modifying Code
1. Preserve existing command/route compatibility and fallback behavior.
2. Keep TypeScript strict typings and existing output/response conventions.
3. Make minimal, targeted edits in the correct layer (`routes`, `services`, `cli`).

## Canonical Reference
For full commands, endpoint semantics, macros, presets, and anti-patterns, read `AGENTS.md`.
