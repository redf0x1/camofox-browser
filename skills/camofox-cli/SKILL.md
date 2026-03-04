---
name: camofox-cli
description: CamoFox CLI — 50 commands for anti-detection browser automation from the terminal. Use when the user needs CLI reference for camofox commands, terminal-based browser control, or a quick lookup of command syntax. Triggers include "camofox command", "CLI reference", "terminal browser", or any request for camofox command-line usage.
allowed-tools: Bash(camofox:*)
---

## 1. Overview

This skill documents the full verified CamoFox CLI surface (50 commands), grouped by category.

- Use `--format json` for machine-readable output
- Most commands auto-resolve the active tab when `[tabId]` is omitted
- Keep `--user <user>` stable across a workflow for consistent session state

## 2. Core Commands (5)

```bash
camofox open <url> [--user <user>] [--viewport <WxH>] [--geo <preset>]
camofox close [tabId] [--user <user>]
camofox snapshot [tabId] [--user <user>]
camofox click <ref> [tabId] [--user <user>]
camofox type <ref> <text> [tabId] [--user <user>]
```

## 3. Navigation Commands (4)

```bash
camofox navigate <url> [tabId] [--user <user>]
camofox screenshot [tabId] [--path <file>] [--output <file>] [--full-page] [--user <user>]
camofox go-back [tabId] [--user <user>]
camofox go-forward [tabId] [--user <user>]
```

## 4. Content Commands (7)

```bash
camofox get-text [tabId] [--selector <selector>] [--user <user>]
camofox get-url [tabId] [--user <user>]
camofox get-links [tabId] [--user <user>]
camofox get-tabs [--user <user>]
camofox eval <expression> [tabId] [--user <user>]
camofox wait <condition> [tabId] [--timeout <ms>] [--user <user>]
camofox search <query> [tabId] [--engine <engine>] [--user <user>]
```

Search engines: `google`, `youtube`, `amazon`, `bing`, `reddit`, `duckduckgo`, `github`, `stackoverflow`.

## 5. Interaction Commands (6)

```bash
camofox fill '<assignments>' [tabId] [--user <user>]
camofox scroll [direction] [tabId] [--amount <N>] [--user <user>]
camofox select <ref> <value> [tabId] [--user <user>]
camofox hover <ref> [tabId] [--user <user>]
camofox press <key> [tabId] [--user <user>]
camofox drag <fromRef> <toRef> [tabId] [--user <user>]
```

Assignment format for `fill`:

```text
[e1]="value1" [e2]="value2"
```

## 6. Console & Error Capture (2)

```bash
camofox console [tabId] [--user <user>] [--type <type>] [--limit <N>] [--clear]
camofox errors [tabId] [--user <user>] [--limit <N>] [--clear]
```

## 7. Tracing Commands (5)

```bash
camofox trace start [--user <user>] [--screenshots] [--snapshots]
camofox trace stop [--user <user>] [--output <file>]
camofox trace chunk-start [--user <user>]
camofox trace chunk-stop [--user <user>] [--output <file>]
camofox trace status [--user <user>]
```

## 8. Session Commands (4)

```bash
camofox session save <name> [tabId] [--user <user>]
camofox session load <name> [tabId] [--user <user>]
camofox session list [--format <format>]
camofox session delete <name> [--force]
```

## 9. Download/Cookie Commands (4)

```bash
camofox cookie export [tabId] [--path <file>] [--user <user>]
camofox cookie import <file> [tabId] [--user <user>]
camofox download [url] [--path <dir>] [--user <user>]
camofox downloads [--user <user>] [--format <format>]
```

## 10. Auth Commands (5)

```bash
camofox auth save <profile-name> [--url <url>] [--notes <notes>]
camofox auth load <profile-name> [--inject [tabId]] [--username-ref <ref>] [--password-ref <ref>] [--user <user>]
camofox auth list [--format <format>]
camofox auth delete <profile-name>
camofox auth change-password <profile-name>
```

## 11. Server Commands (3)

```bash
camofox server start [--port <port>] [--background] [--idle-timeout <minutes>]
camofox server stop
camofox server status [--format <format>]
```

## 12. Advanced Commands (4)

```bash
camofox annotate [tabId] [--user <user>] [--output <file>] [--format <format>]
camofox health [--format <format>]
camofox version [--format <format>]
camofox info [--format <format>]
```

## 13. Pipeline Command (1)

```bash
camofox run <script-file> [--continue-on-error]
```

`run` executes sequential CLI command scripts (file path or `-` for stdin). It does not execute JavaScript/TypeScript source files.

## 14. Global Options

```bash
--user <user>
--port <port>
--format <format>    # json|text|plain
--local              # reserved for v2
-V, --version
-h, --help
```

## 15. Full Command Index (50)

1. `open`
2. `close`
3. `snapshot`
4. `click`
5. `type`
6. `navigate`
7. `screenshot`
8. `go-back`
9. `go-forward`
10. `get-text`
11. `get-url`
12. `get-links`
13. `get-tabs`
14. `eval`
15. `wait`
16. `search`
17. `fill`
18. `scroll`
19. `select`
20. `hover`
21. `press`
22. `drag`
23. `console`
24. `errors`
25. `trace start`
26. `trace stop`
27. `trace chunk-start`
28. `trace chunk-stop`
29. `trace status`
30. `session save`
31. `session load`
32. `session list`
33. `session delete`
34. `cookie export`
35. `cookie import`
36. `download`
37. `downloads`
38. `auth save`
39. `auth load`
40. `auth list`
41. `auth delete`
42. `auth change-password`
43. `server start`
44. `server stop`
45. `server status`
46. `annotate`
47. `health`
48. `version`
49. `info`
50. `run`
