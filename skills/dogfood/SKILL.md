---
name: dogfood
description: QA testing workflow for CamoFox Browser — systematic testing with console capture, error detection, and Playwright tracing
---

# Dogfood QA Testing — camofox-browser

> Systematic exploratory testing of web applications using camofox-browser's anti-detection browser automation.

## When to Use
- Testing web applications for bugs, UX issues, and accessibility problems
- QA validation before release
- Exploratory testing of new features
- Cross-browser verification with Firefox/Camoufox engine

## Prerequisites
- camofox-browser server running on port 9377
- Target application URL accessible

## Workflow

### Phase 1: Initialize Session
```bash
# Create a dedicated test session
camofox open "about:blank" --user dogfood-qa

# Start trace recording for evidence capture
camofox trace start --user dogfood-qa --screenshots --snapshots
```

### Phase 2: Navigate & Orient
```bash
# Navigate to target application
camofox navigate "https://target-app.com" --user dogfood-qa

# Take initial snapshot to understand page structure
camofox snapshot --user dogfood-qa

# Capture annotated screenshot for visual baseline
camofox annotate --user dogfood-qa
```

### Phase 3: Systematic Exploration

#### 3.1 Happy Path Testing
Follow the primary user flows:
```bash
# Interact with elements using refs from snapshot
camofox click e5 --user dogfood-qa
camofox type e3 "test input" --user dogfood-qa
camofox press Enter --user dogfood-qa

# Wait for navigation/loading
camofox wait networkidle --user dogfood-qa

# Capture state after each action
camofox snapshot --user dogfood-qa
```

#### 3.2 Edge Case Testing
```bash
# Test empty inputs
camofox type e3 "" --user dogfood-qa
camofox press Enter --user dogfood-qa

# Test long strings
camofox type e3 "aaaa...very long string..." --user dogfood-qa
camofox press Enter --user dogfood-qa

# Test special characters
camofox type e3 "<script>alert('xss')</script>" --user dogfood-qa
camofox press Enter --user dogfood-qa
```

#### 3.3 Error Discovery
```bash
# Check for console errors after interactions
camofox errors --user dogfood-qa

# Check console output for warnings
camofox console --user dogfood-qa --type warning

# Monitor all console messages
camofox console --user dogfood-qa --limit 50
```

#### 3.4 State & Navigation Testing
```bash
# Test back/forward navigation
camofox go-back --user dogfood-qa
camofox go-forward --user dogfood-qa

# Save session state for later comparison
camofox session save dogfood-qa-state --user dogfood-qa

# Test page reload
camofox navigate "https://target-app.com" --user dogfood-qa
```

### Phase 4: Document Issues

When a bug is found:
```bash
# 1. Capture visual evidence
camofox annotate --user dogfood-qa

# 2. Capture page errors
camofox errors --user dogfood-qa

# 3. Capture console logs
camofox console --user dogfood-qa

# 4. Mark trace chunk for this specific issue
camofox trace chunk-start --user dogfood-qa
# ... reproduce the bug ...
camofox trace chunk-stop --user dogfood-qa

# 5. Take snapshot for element state
camofox snapshot --user dogfood-qa
```

### Phase 5: Wrap Up
```bash
# Stop trace recording
camofox trace stop --user dogfood-qa
# → Trace ZIP saved to ~/.camofox/traces/
# → View at https://trace.playwright.dev

# Final console/error summary
camofox errors --user dogfood-qa
camofox console --user dogfood-qa --type error

# Close session
camofox close --user dogfood-qa
```

## Issue Reporting

Use the [issue taxonomy](references/issue-taxonomy.md) to classify findings.
Use the [report template](templates/dogfood-report-template.md) to document each issue.

## Key Differences from Standard Browser Testing

| Feature | Standard | camofox-browser |
|---|---|---|
| Detection | Easily flagged as bot | Anti-detection (C++ spoofing) |
| Browser | Chrome/Chromium | Firefox/Camoufox |
| Evidence | Screenshots only | Traces (screenshots + DOM + network) |
| Console | Manual DevTools | `console` / `errors` commands |
| Element refs | CSS selectors | Accessibility tree refs (eN) |

## Tips
- Use `trace chunk-start/stop` to isolate specific bug reproductions within a longer session
- Check `errors` frequently — many bugs show console errors before visual symptoms
- Use `annotate` for visual evidence — it numbers all interactive elements
- Trace ZIPs contain full reproduction data — share via trace.playwright.dev
- The `--user` flag isolates test sessions from each other
