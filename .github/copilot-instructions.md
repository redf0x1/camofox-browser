# CamoFox Browser — GitHub Copilot Instructions

## What CamoFox Is
CamoFox Browser is an anti-detection browser automation server for AI agents. It wraps Camoufox (a Firefox fork with engine-level fingerprint spoofing) behind a TypeScript Express REST API and a `camofox` CLI. It is designed for agent workflows where deterministic element interaction, persistent user profiles, and structured output matter more than raw browser scripting.

## Core Workflow (Snapshot-First)
1. Create/open a tab (`open` or `POST /tabs`)
2. Capture snapshot (`snapshot` or `GET /tabs/:tabId/snapshot`)
3. Choose refs from snapshot (`e1`, `e2`, ...)
4. Interact (`click`, `type`, `fill`, `press`, `scroll`, etc.)
5. Re-snapshot after major DOM changes/navigation
6. Repeat until done, then close tab/session

Always prefer ref-driven interaction over brittle selectors.

## Most-Used CLI Commands
```bash
# Lifecycle / navigation
camofox open <url> [--user <id>] [--viewport 1280x720] [--geo <preset>]
camofox navigate <url> [tabId] [--user <id>]
camofox go-back [tabId] [--user <id>]
camofox go-forward [tabId] [--user <id>]
camofox close [tabId] [--user <id>]

# Snapshot + inspection
camofox snapshot [tabId] [--user <id>]
camofox screenshot [tabId] [--output file] [--full-page]
camofox annotate [tabId] [--output file]
camofox get-url [tabId] [--user <id>]
camofox get-text [tabId] [--selector <css>] [--user <id>]
camofox get-links [tabId] [--user <id>]
camofox get-tabs [--user <id>]

# Interaction
camofox click <ref> [tabId] [--user <id>]
camofox type <ref> <text> [tabId] [--user <id>]
camofox fill '[e1]="user" [e2]="pass"' [tabId] [--user <id>]
camofox press <key> [tabId] [--user <id>]
camofox scroll [down|up|left|right] [tabId] [--amount 500]
camofox select <ref> <value> [tabId]
camofox hover <ref> [tabId]
camofox drag <fromRef> <toRef> [tabId]

# Utility
camofox wait <condition> [tabId] [--timeout 10000]
camofox eval "document.title" [tabId]
camofox search "query" [tabId] --engine google
camofox run <script-file> [--continue-on-error]

# Session / auth / server
camofox session save <name> [tabId]
camofox session load <name> [tabId]
camofox auth save <profile>
camofox auth load <profile> --inject --username-ref eX --password-ref eY
camofox server status
```

## Essential Rules
- Use snapshot-first: never guess refs; always call `snapshot` before interacting.
- Scope every action by `userId`/`--user`; tab lookup is user-scoped.
- Favor refs over selectors; selectors are fallback only.
- Prefer `--format json` for agent parsing and automation pipelines.
- Keep secrets out of output; use auth vault + `auth load --inject`.
- Use existing endpoints/commands before adding new ones; preserve backward-compatible aliases.

## API Basics
- Base URL: `http://localhost:9377`
- API Documentation: `GET /api/docs` (Swagger UI), `GET /openapi.json` (OpenAPI 3.1.0 spec for a representative subset of routes)
- Health: `GET /health`
- Create tab: `POST /tabs` with `{ userId, sessionKey|listItemId, url? }`
- List tabs: `GET /tabs?userId=...`
- Navigate: `POST /tabs/:tabId/navigate`
- Snapshot: `GET /tabs/:tabId/snapshot?userId=...`
- Click/type: `POST /tabs/:tabId/click`, `POST /tabs/:tabId/type`
- Evaluate JS: `POST /tabs/:tabId/evaluate`, `POST /tabs/:tabId/evaluate-extended`
- Close tab/session: `DELETE /tabs/:tabId`, `DELETE /sessions/:userId`
- Cookie import/export: `POST /sessions/:userId/cookies`, `GET /tabs/:tabId/cookies`

Protected endpoints require `Authorization: Bearer $CAMOFOX_API_KEY` only when `CAMOFOX_API_KEY` is set; `POST /stop` always requires `x-admin-key` via `CAMOFOX_ADMIN_KEY`.

Most core success responses are structured as JSON, commonly including `ok: true` on action-style endpoints.

## Stack
- Runtime: Node.js 22+
- Language: TypeScript (strict)
- Server: Express
- CLI: Commander.js
- Testing: Jest
- Browser engine: Camoufox (Firefox-based anti-detection)

## Source of Truth
Use `AGENTS.md` as the canonical, full project guide (commands, workflows, endpoint semantics, anti-patterns, and conventions). This file is an optimized Copilot summary, not the complete spec.
