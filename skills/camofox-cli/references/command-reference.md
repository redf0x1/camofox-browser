# CamoFox CLI Command Reference

## Quick Reference Table

### Core Commands (5)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `open` | Open new tab | `--user`, `[url]` |
| `close` | Close active tab or specified tab | `--user`, `[tabId]` |
| `snapshot` | Capture accessibility snapshot with refs | `--user`, `[tabId]` |
| `click` | Click element by ref/selector | `--user`, `<ref>`, `[tabId]` |
| `type` | Type into element by ref/selector | `--user`, `<ref>`, `<text>`, `[tabId]` |

### Navigation Commands (4)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `navigate` | Navigate tab to URL | `--user`, `<url>`, `[tabId]` |
| `screenshot` | Save screenshot PNG | `--user`, `[tabId]`, `--output`, `--full-page` |
| `go-back` | Go back in history | `--user`, `[tabId]` |
| `go-forward` | Go forward in history | `--user`, `[tabId]` |

### Content Commands (7)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `get-text` | Extract visible text | `--user`, `[tabId]`, `--selector` |
| `get-url` | Get current URL | `--user`, `[tabId]` |
| `get-links` | Get links from page | `--user`, `[tabId]` |
| `get-tabs` | List open tabs | `--user` |
| `eval` | Evaluate JavaScript expression | `--user`, `<expression>`, `[tabId]` |
| `wait` | Wait for condition/selector/navigation | `--user`, `<condition>`, `[tabId]`, `--timeout` |
| `search` | Search using built-in engines | `--user`, `<query>`, `[tabId]`, `--engine` |

### Interaction Commands (6)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `fill` | Fill multiple fields | `--user`, `<assignments>`, `[tabId]` |
| `scroll` | Scroll page | `--user`, `[direction]`, `[tabId]`, `--amount` |
| `select` | Select dropdown value | `--user`, `<ref>`, `<value>`, `[tabId]` |
| `hover` | Hover over element | `--user`, `<ref>`, `[tabId]` |
| `press` | Press key | `--user`, `<key>`, `[tabId]` |
| `drag` | Drag and drop element | `--user`, `<fromRef>`, `<toRef>`, `[tabId]` |

### Console & Error Capture (2)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `console` | Get console logs | `--user`, `[tabId]`, `--type`, `--limit`, `--clear` |
| `errors` | Get captured page errors | `--user`, `[tabId]`, `--limit`, `--clear` |

### Tracing Commands (5)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `trace start` | Start trace recording | `--user`, `--screenshots`, `--snapshots` |
| `trace stop` | Stop trace and save ZIP | `--user`, `--output` |
| `trace chunk-start` | Start trace chunk | `--user` |
| `trace chunk-stop` | Stop trace chunk and save ZIP | `--user`, `--output` |
| `trace status` | Show tracing status | `--user` |

### Session Commands (4)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `session save` | Save session | `--user`, `<name>`, `[tabId]` |
| `session load` | Restore session | `--user`, `<name>`, `[tabId]` |
| `session list` | List saved sessions | `--format` |
| `session delete` | Delete saved session | `<name>`, `--force` |

### Download/Cookie Commands (4)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `cookie export` | Export cookies to JSON | `--user`, `[tabId]`, `--path` |
| `cookie import` | Import cookies from JSON | `--user`, `<file>`, `[tabId]` |
| `download` | Download from URL (stub/placeholder) | `--user`, `[url]`, `--path` |
| `downloads` | List tracked downloads | `--user`, `--format` |

### Auth Commands (5)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `auth save` | Save encrypted credentials profile | `<profile-name>`, `--url`, `--notes` |
| `auth load` | Load credentials / inject into page | `<profile-name>`, `--inject`, `--username-ref`, `--password-ref`, `--user` |
| `auth list` | List auth profiles | `--format` |
| `auth delete` | Delete auth profile | `<profile-name>` |
| `auth change-password` | Rotate profile master password | `<profile-name>` |

### Server Commands (3)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `server start` | Start local server | `--port`, `--background`, `--idle-timeout` |
| `server stop` | Stop local server | *(none)* |
| `server status` | Show server status | `--format` |

### Advanced Commands (4)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `annotate` | Screenshot with element refs | `--user`, `[tabId]`, `--output`, `--format` |
| `health` | Health check | `--format` |
| `version` | Show CLI/server version info | `--format` |
| `info` | Show runtime configuration | `--format` |

### Pipeline Command (1)

| Command | Description | Key Options |
|---------|-------------|-------------|
| `run` | Execute script of CLI commands | `<script-file>`, `--continue-on-error` |
