---
name: camofox-browser
description: Anti-detection browser automation for AI agents. Use when the user needs stealth web browsing, undetectable scraping, fingerprint spoofing, proxy rotation, or privacy-focused browser automation. Triggers include "stealth scrape", "anti-detection", "bypass fingerprinting", "camofox", "camoufox", "undetectable browser", "bot evasion", or any browser task requiring evasion of bot detection systems.
allowed-tools: Bash(camofox:*)
---

# camofox-browser Skill

Camofox is an anti-detection browser automation system built on Camoufox + Playwright with:
- CLI (`camofox`) for operator workflows
- REST API (port `9377` by default) for programmatic control
- OpenClaw plugin integration (`plugin.ts`) with 19 plugin tools

This skill is optimized for bot-evasion workflows where default browser automation gets flagged.

### Camofox vs generic browser skills

Use this skill instead of generic browser tooling when at least one applies:
- You need anti-detection browser identity continuity across sessions.
- You need proxy-aware geolocation behavior and region presets.
- You need OpenClaw plugin compatibility with dedicated camofox tool names.
- You need both CLI and REST API control paths against the same runtime.

Do **not** use this skill if you only need a simple local static page script and anti-detection is irrelevant.

### Fast interface chooser

Use CLI when:
- You are running interactive ops/debugging from terminal.
- You want local encrypted vault prompts for credentials.
- You want quick one-shot command chaining with active tab memory.

Use REST API when:
- You are integrating from another service/agent runtime.
- You need strict request/response control with explicit `userId` and `tabId`.
- You need OpenClaw-compatible route shape (`/tabs/open`, `/act`, `/snapshot`).

## 1) Core Workflow (CLI + API dual interface)

Follow this loop for reliable automation:

1. Create/open tab
2. Snapshot to get fresh `eN` refs
3. Interact using refs
4. Re-snapshot after DOM/navigation changes
5. Keep `userId` stable for session continuity

CLI:
```bash
camofox open https://example.com --user agent1
camofox snapshot --user agent1
camofox click e5 --user agent1
camofox type e7 "hello world" --user agent1
```

API:
```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","sessionKey":"default","url":"https://example.com"}'

curl "http://localhost:9377/tabs/<tabId>/snapshot?userId=agent1"

curl -X POST http://localhost:9377/tabs/<tabId>/click \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","ref":"e5"}'
```

Dual interface mapping (most common path):

| Intent | CLI | API |
|---|---|---|
| Open tab | `camofox open <url>` | `POST /tabs` |
| Snapshot refs | `camofox snapshot` | `GET /tabs/:tabId/snapshot` |
| Click element | `camofox click <ref>` | `POST /tabs/:tabId/click` |
| Type text | `camofox type <ref> <text>` | `POST /tabs/:tabId/type` |
| Navigate | `camofox navigate <url>` | `POST /tabs/:tabId/navigate` |
| Screenshot | `camofox screenshot` | `GET /tabs/:tabId/screenshot` |

Ref format reminder:
- Camofox refs are `eN` values (example `e1`, `e2`) in normal command usage.
- Some subcommands accept bracketed values in form assignments (`[e1]="value"`).

## 2) Anti-Detection Overview (Camoufox-specific)

Camofox differs from generic browser tools by using Camoufox launch options and per-profile fingerprint persistence:
- Camoufox launch via `camoufox-js` (`launchOptions`)
- Generated fingerprint (`generateFingerprint`) persisted per profile dir
- Humanization enabled (`humanize: true`)
- Proxy-aware geo behavior (`geoip: true` when proxy configured)
- Persistent contexts per user (`~/.camofox/profiles/<user>`) to keep believable identity continuity

Operational anti-detection behaviors:
- Stable identity per `userId`
- Optional proxy credentials from `PROXY_HOST/PORT/USERNAME/PASSWORD`
- Optional headed/virtual display modes with Xvfb fallback on Linux

Execution behavior that helps evade brittle bot checks:
- Persistent profile directories avoid fresh-device fingerprints every run.
- Consistent session reuse lowers abrupt storage/token churn.
- Engine-level spoofing avoids fragile JS-patch race with site updates.

See deep-dive: `references/anti-detection.md`.

## 3) Essential CLI Commands (quick reference)

Core:
```bash
camofox open <url> [--user <user>] [--viewport <WxH>] [--geo <preset>]
camofox close [tabId] [--user <user>]
camofox snapshot [tabId] [--user <user>]
camofox click <ref> [tabId] [--user <user>]
camofox type <ref> <text> [tabId] [--user <user>]
```

Navigation + interaction:
```bash
camofox navigate <url> [tabId] [--user <user>]
camofox screenshot [tabId] [--output <file>] [--full-page] [--user <user>]
camofox fill '[e1]="john" [e2]="john@example.com"' [tabId] [--user <user>]
camofox press Enter [tabId] [--user <user>]
```

Inspection:
```bash
camofox get-text [tabId] [--selector <css>] [--user <user>]
camofox get-links [tabId] [--user <user>]
camofox eval '<js expression>' [tabId] [--user <user>]
camofox wait <selector|navigation|networkidle> [tabId] [--timeout <ms>] [--user <user>]
```

Search:
```bash
camofox search "openclaw plugin" --engine github [tabId] [--user <user>]
```

Full catalog (all 50): `references/cli-commands.md`.

Global flag reminders:
```bash
--user <user>
--port <port>
--format json|text|plain
```

## 4) Essential API Endpoints (quick reference)

Core tab flow:
```bash
POST   /tabs
GET    /tabs
POST   /tabs/:tabId/navigate
GET    /tabs/:tabId/snapshot
POST   /tabs/:tabId/click
POST   /tabs/:tabId/type
DELETE /tabs/:tabId
```

State + assets:
```bash
POST   /sessions/:userId/cookies
GET    /tabs/:tabId/cookies
GET    /tabs/:tabId/screenshot
GET    /tabs/:tabId/downloads
GET    /users/:userId/downloads
```

Advanced:
```bash
POST   /tabs/:tabId/evaluate
POST   /tabs/:tabId/evaluate-extended
POST   /tabs/:tabId/extract-resources
POST   /tabs/:tabId/batch-download
POST   /tabs/:tabId/resolve-blobs
```

OpenClaw compatibility routes:
```bash
GET    /
POST   /tabs/open
POST   /start
POST   /stop
POST   /navigate
GET    /snapshot
POST   /act
```

Full endpoint map (all 48): `references/api-endpoints.md`.

Compatibility warning:
- `plugin.ts` includes a tool targeting `/youtube/transcript`, but current server route registration does not expose this endpoint.

## 5) Common Patterns

### A) Form fill + submit
CLI:
```bash
camofox snapshot --user agent1
camofox fill '[e4]="Jane Doe" [e5]="jane@example.com"' --user agent1
camofox press Enter --user agent1
```

Safety notes:
- Re-snapshot if the form mutates between fields.
- Keep same `--user` on every step to preserve tab ownership.

API:
```bash
curl -X POST http://localhost:9377/tabs/<tabId>/type \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","ref":"e5","text":"jane@example.com"}'
```

### B) Stealth scraping loop
```bash
camofox open https://target.example --user scraper-us
camofox snapshot --user scraper-us
camofox get-text --selector "main" --user scraper-us
camofox get-links --user scraper-us
```

Recommended loop shape:
1. open page
2. snapshot
3. capture text/links/resources
4. paginate or navigate next URL
5. snapshot again

### C) Search workflow (CLI engines)
```bash
camofox search "best playwright anti-detection" --engine duckduckgo --user research1
```

When using CLI search:
- Engine list is fixed to the 8 implemented CLI engines.
- Use API macro navigate for 14 macro targets where supported.

### D) API macro navigation
```bash
curl -X POST http://localhost:9377/tabs/<tabId>/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","macro":"@google_search","query":"camoufox js"}'
```

## 6) Authentication (Auth Vault)

Auth Vault is local encrypted credential storage for CLI workflows.

Commands:
```bash
camofox auth save <profile-name> [--url <url>] [--notes <notes>]
camofox auth load <profile-name>
camofox auth load <profile-name> --inject [tabId] --username-ref <ref> --password-ref <ref> [--user <user>]
camofox auth list [--format <format>]
camofox auth delete <profile-name>
camofox auth change-password <profile-name>
```

Security model (implemented):
- Payload encryption: AES-256-GCM
- KDF: Argon2id preferred, PBKDF2 fallback
- Salt: 16 bytes
- IV: 12 bytes
- Vault dir mode: `0700`
- Secret file mode: `0600`

Operational guidance:
- Avoid scripting raw passwords in shell history.
- Prefer vault injection for login workflows in shared-agent logs.
- Rotate vault profile master password regularly for long-lived bots.

See: `references/authentication.md`.

## 7) Session Management (`userId` isolation)

Session identity is scoped by `userId` and persistent profile dir:
- Browser context keyed by `userId`
- Cookies, profile, fingerprint continuity tied to same `userId`
- Mixing users in one flow breaks tab lookup consistency

CLI pattern:
```bash
camofox open https://example.com --user account-a
camofox snapshot --user account-a
camofox click e9 --user account-a
```

Cookie session file helpers:
```bash
camofox session save checkout-flow --user account-a
camofox session load checkout-flow --user account-a
```

Isolation reminder:
- `tabId` lookup is user-scoped.
- Using wrong `userId` with valid `tabId` returns not found behavior.

## 8) Search Macros (CLI vs API — distinct systems)

Important distinction:

- CLI `search` supports **8 engines**:
  `google`, `youtube`, `amazon`, `bing`, `reddit`, `duckduckgo`, `github`, `stackoverflow`

- API `navigate` macro supports **14 macros** in `src/utils/macros.ts`:
  `@google_search`, `@youtube_search`, `@amazon_search`, `@reddit_search`, `@reddit_subreddit`, `@wikipedia_search`, `@twitter_search`, `@yelp_search`, `@spotify_search`, `@netflix_search`, `@linkedin_search`, `@instagram_search`, `@tiktok_search`, `@twitch_search`

CLI example:
```bash
camofox search "vite plugin" --engine github --user dev1
```

API macro example:
```bash
curl -X POST http://localhost:9377/tabs/<tabId>/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId":"dev1","macro":"@google_search","query":"vite plugin github"}'
```

Note: API macros and CLI search engines are different systems. Keep CLI/API behavior separate.

Macro mismatch reminder:
- CLI has `github` and `stackoverflow` engines.
- API macro set does not define `@github_search` or `@stackoverflow_search` in current macro implementation.

## 9) Geo Presets (8 presets)

Built-in preset names:
- `us-east`
- `us-west`
- `japan`
- `uk`
- `germany`
- `vietnam`
- `singapore`
- `australia`

CLI:
```bash
camofox open https://example.com --geo japan --user jp-agent
```

API:
```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"jp-agent","sessionKey":"default","preset":"japan","url":"https://example.com"}'
```

Preset best practice:
- Keep preset and proxy region coherent to avoid obvious locale/network mismatch.

## 10) Security (proxy, anti-detection settings)

Use environment variables for hardened operation:
```bash
export CAMOFOX_API_KEY='<api-key>'
export CAMOFOX_ADMIN_KEY='<admin-key>'
export PROXY_HOST='proxy.example.net'
export PROXY_PORT='8080'
export PROXY_USERNAME='proxy-user'
export PROXY_PASSWORD='proxy-pass'
```

Behavior notes:
- Cookie import/export and evaluate endpoints enforce bearer auth only when `CAMOFOX_API_KEY` is configured.
- OpenClaw `/stop` requires admin key authorization.
- `camofox download` is currently a stub/placeholder in CLI (documented intentionally).

Suggested baseline environment:
```bash
export CAMOFOX_PORT=9377
export CAMOFOX_HEADLESS=virtual
export CAMOFOX_MAX_SESSIONS=20
export CAMOFOX_MAX_TABS=10
```

## 11) Scripting (`camofox run`)

`camofox run` is a sequential script runner (not a DAG/orchestration pipeline).

```bash
camofox run script.txt
camofox run script.txt --continue-on-error
cat script.txt | camofox run -
```

Script format:
- One command per line
- `#` comments supported
- Supports quoted args
- Nested `run` is rejected

Example script (`login-and-capture.cf`):
```text
# open login page
open https://example.com/login --user ops1
snapshot --user ops1
fill '[e3]="user@example.com" [e4]="not-stored-here"' --user ops1
press Enter --user ops1
wait networkidle --timeout 12000 --user ops1
screenshot --output login-result.png --user ops1
```

## 12) Deep-Dive Documentation

- `references/cli-commands.md` — Full CLI command catalog and usage patterns.
- `references/api-endpoints.md` — Complete REST API route map and request/response notes.
- `references/openclaw-tools.md` — OpenClaw plugin tool list and route/tool mapping.
- `references/anti-detection.md` — Camoufox anti-detection model, fingerprint continuity, and stealth guidance.
- `references/authentication.md` — Auth Vault encryption model and credential workflows.
- `references/session-management.md` — `userId` isolation, context lifecycle, and session continuity.
- `references/search-macros.md` — CLI search engines vs API macro navigation behavior.
- `references/proxy-presets.md` — Geo presets, proxy settings, and region-alignment practices.
- `references/scripting.md` — `camofox run` script format, constraints, and execution behavior.
- `references/snapshot-refs.md` — Snapshot reference handling (`eN`), refresh rules, and element targeting reliability.
- `references/media-extraction.md` — Screenshot/download/resource extraction and media workflows.
- `references/display-vnc.md` — Headed/virtual display modes and VNC operation guidance.

## 13) Ready-to-Use Templates

- `templates/stealth-scraping.sh` — Stealth scraping workflow with anti-detection defaults.
- `templates/search-and-extract.sh` — Search across engines and extract structured results.
- `templates/authenticated-session.sh` — Auth Vault login and authenticated session flow.
- `templates/form-automation.sh` — Form automation using snapshot-interact-verify loops.
- `templates/multi-session-pipeline.sh` — Parallel multi-session collection pipeline.
- `templates/screenshot-capture.sh` — Screenshot capture workflow for audits and evidence.

## 14) Important Notes

- Plugin system in this repository is **OpenClaw plugin tools**, not MCP tools.
- There is **no MCP server implementation** in this codebase.
- OpenClaw plugin currently defines 19 tools in `plugin.ts`.
- A plugin tool references `/youtube/transcript`, but this route is **not registered** in current server routes (`core.ts`, `openclaw.ts`). Treat it as unavailable endpoint.
- CLI element refs are `eN` (for example `e1`, `e2`), not `@eN`.
- Source of truth for development decisions: `AGENTS.md`.

High-confidence troubleshooting checklist:
1. `camofox health --format json`
2. Confirm tab exists with `camofox get-tabs --user <user> --format json`
3. Refresh refs with `camofox snapshot`
4. Re-run failing action with same `--user`
5. If display mode changed, create new tab (old tab ids invalid)

### Appendix A — 50-command quick index

Core (5):
- `open`
- `close`
- `snapshot`
- `click`
- `type`

Navigation (4):
- `navigate`
- `screenshot`
- `go-back`
- `go-forward`

Content (7):
- `get-text`
- `get-url`
- `get-links`
- `get-tabs`
- `eval`
- `wait`
- `search`

Interaction (6):
- `fill`
- `scroll`
- `select`
- `hover`
- `press`
- `drag`

Console/error capture (2):
- `console`
- `errors`

Tracing (5):
- `trace start`
- `trace stop`
- `trace chunk-start`
- `trace chunk-stop`
- `trace status`

Session (4):
- `session save`
- `session load`
- `session list`
- `session delete`

Download/cookie (4):
- `cookie export`
- `cookie import`
- `download` (stub)
- `downloads`

Auth (5):
- `auth save`
- `auth load`
- `auth list`
- `auth delete`
- `auth change-password`

Server (3):
- `server start`
- `server stop`
- `server status`

Advanced (4):
- `annotate`
- `health`
- `version`
- `info`

Pipeline (1):
- `run`

### Appendix B — API endpoint families

Core REST routes (`core.ts`):
- Cookies: import/export by user/tab
- Lifecycle: health, presets, tab create/list/close, session close
- Interaction: navigate, snapshot, wait, click, type, press, scroll, scroll-element
- Eval: evaluate + evaluate-extended
- Navigation state: back, forward, refresh
- Extraction: links, screenshot, stats, extract-resources, batch-download, resolve-blobs
- Download tracking: list/get/content/delete
- Display mode: toggle-display

OpenClaw routes (`openclaw.ts`):
- `/`, `/tabs/open`, `/start`, `/stop`, `/navigate`, `/snapshot`, `/act`

### Appendix C — response handling recommendations

CLI output handling:
- Prefer `--format json` for machine parsing.
- Use `plain` only when expecting one scalar (for example direct path or status string).
- Avoid parsing text output with fragile shell splitting.

API response handling:
- Treat 4xx errors as actionable request/user/tab mismatch first.
- Retry only idempotent reads (`GET`) by default.
- For `evaluate-extended`, handle `429` and `408` explicitly.

### Appendix D — mismatch and compatibility guardrails

Documented guardrails for this repository revision:
- OpenClaw plugin tool system exists and is first-class.
- MCP server implementation does **not** exist in this codebase.
- Plugin tool `camofox_youtube_transcript` references a route not currently registered in route files.
- CLI `download` remains placeholder/stub and should be treated as non-functional direct download command.

### Appendix E — minimum safe automation contract

If you need robust automations, enforce this contract in your agent logic:
1. Always pass explicit `userId` (or `--user`) for every command/call.
2. Always obtain snapshot before actions that depend on refs.
3. Always reacquire refs after navigation or major dynamic update.
4. Always close user sessions (`DELETE /sessions/:userId`) on teardown in long-running systems.
5. Always persist auth/cookies via vault or cookie import rather than plaintext scripts.
