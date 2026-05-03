# Proxy and Presets

This reference covers built-in geo presets, custom preset loading, and proxy behavior in camofox-browser.

Related:
- `../SKILL.md`
- `./session-management.md`
- `./api-endpoints.md`
- `./cli-commands.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Built-in geo presets (8)
2. Preset resolution and validation
3. Custom presets (`CAMOFOX_PRESETS_FILE`)
4. Session-level proxy and geo model
5. Proxy profiles (`CAMOFOX_PROXY_PROFILES_FILE`)
6. Geo modes: explicit-wins vs proxy-locked
7. Session identity and reuse rules
8. CLI proxy and geo flags
9. API examples
10. Notes and caveats

---

## 1) Built-in geo presets (8)

Defined in `src/utils/presets.ts` as `BUILT_IN_PRESETS`:

| Preset | Locale | Timezone | Geolocation (lat, lon) |
|---|---|---|---|
| `us-east` | `en-US` | `America/New_York` | `40.7128, -74.006` |
| `us-west` | `en-US` | `America/Los_Angeles` | `34.0522, -118.2437` |
| `japan` | `ja-JP` | `Asia/Tokyo` | `35.6895, 139.6917` |
| `uk` | `en-GB` | `Europe/London` | `51.5074, -0.1278` |
| `germany` | `de-DE` | `Europe/Berlin` | `52.52, 13.405` |
| `vietnam` | `vi-VN` | `Asia/Ho_Chi_Minh` | `10.8231, 106.6297` |
| `singapore` | `en-SG` | `Asia/Singapore` | `1.3521, 103.8198` |
| `australia` | `en-AU` | `Australia/Sydney` | `-33.8688, 151.2093` |

---

## 2) Preset resolution and validation

`resolveContextOptions()` behavior:

1. Start from `preset` if provided
2. Apply explicit overrides: `locale`, `timezoneId`, `geolocation`, `viewport`
3. Validate with `validateContextOptions()`

Validation includes locale format, IANA timezone validity (when available), geolocation ranges, and viewport bounds.

---

## 3) Custom presets (`CAMOFOX_PRESETS_FILE`)

Custom presets are loaded at module init via environment variable:

```bash
CAMOFOX_PRESETS_FILE=/absolute/path/to/presets.json
```

Example file:

```json
{
  "canada-east": {
    "locale": "en-CA",
    "timezoneId": "America/Toronto",
    "geolocation": { "latitude": 43.6532, "longitude": -79.3832 }
  }
}
```

Rules:

- file must be a JSON object
- keys are normalized to lowercase
- custom preset names override built-ins on conflict
- load failures are logged as warnings and do not crash startup

---

## 4) Session-level proxy and geo model

CamoFox supports a hybrid proxy configuration model with three layers:

### Server-level baseline (environment variables)
Configured via `src/utils/config.ts`:
- `PROXY_HOST`
- `PROXY_PORT`
- `PROXY_USERNAME`
- `PROXY_PASSWORD`

When configured, these values:
- Serve as the default proxy for all sessions
- Enable Camoufox geoip mode (proxy-derived geo suggestions)
- Remain the baseline unless overridden at the session level

### Session-level overrides (API/CLI)
`POST /tabs` and CLI `camofox open` accept:
- `proxyProfile` — select a named profile from `CAMOFOX_PROXY_PROFILES_FILE`
- `proxy` — provide raw proxy fields (`host`, `port`, `username`, `password`)

Session-level proxy overrides the server baseline for that specific `userId + sessionKey`.

### Session identity and reuse
Implemented in `src/services/session-profile-resolver.ts`:
- Proxy/geo configuration is scoped by `userId + sessionKey`, not just `userId`
- The same `userId` may run different `sessionKey` profiles in parallel with different proxy/geo
- The same `userId + sessionKey` combination maintains a stable identity:
  - First request establishes the profile
  - Subsequent requests with conflicting proxy/geo fields are rejected
  - Profile persists until session cleanup/eviction
- Session cleanup and context eviction operate on the `userId + sessionKey` scope

---

## 5) Proxy profiles (`CAMOFOX_PROXY_PROFILES_FILE`)

Named proxy profiles allow reusable proxy configurations.

### Configuration
Set environment variable to a JSON file path:
```bash
CAMOFOX_PROXY_PROFILES_FILE=/absolute/path/to/proxy-profiles.json
```

### File format
```json
{
  "tokyo-exit": {
    "host": "tokyo.proxy.example.com",
    "port": 8080,
    "username": "user",
    "password": "pass"
  },
  "london-exit": {
    "host": "london.proxy.example.com",
    "port": 8080
  }
}
```

### Usage
Select by name in API or CLI:
```bash
# CLI
camofox open https://example.com --proxy-profile tokyo-exit

# API
POST /tabs
{
  "userId": "agent1",
  "sessionKey": "task1",
  "url": "https://example.com",
  "proxyProfile": "tokyo-exit"
}
```

### Loading behavior
- File is loaded at module init via `src/utils/proxy-profiles.ts`
- Profile names are normalized to lowercase
- Invalid or missing files log warnings but do not crash startup
- Profiles are validated for required `host` and `port` fields

---

## 6) Geo modes: explicit-wins vs proxy-locked

CamoFox offers two geo modes that control how explicit geo fields interact with proxy-derived geo.

### `geoMode=explicit-wins` (default)
- Explicit geo fields (`locale`, `timezoneId`, `geolocation`) remain authoritative
- Proxy-derived geo suggestions are ignored
- Use when you want precise geo control regardless of proxy location
- Example: proxy exits in London, but you specify `preset: "japan"` — Japan geo wins

### `geoMode=proxy-locked`
- Requires proxy-derived geo and explicit geo to align
- Rejects requests where explicit geo conflicts with proxy-derived geo
- Proxy-derived geo is authoritative
- Use when geo consistency with proxy exit location is critical
- Example: proxy exits in London with `preset: "japan"` — request is rejected

### Implementation
Resolved in `src/services/session-profile-resolver.ts`:
- Default mode is `explicit-wins`
- Mode is part of the session profile identity
- Changing `geoMode` for an existing `userId + sessionKey` is rejected

---

## 7) Session identity and reuse rules

### Profile key construction
A session profile is identified by:
- `userId`
- `sessionKey`
- Proxy configuration (server env, named profile, or raw fields)
- Geo configuration (preset, explicit fields, geoMode)

### Stability guarantees
1. **Same userId, different sessionKey**: Different sessions with different proxy/geo configurations can run in parallel
2. **Same userId + sessionKey**: Maintains a stable identity:
   - First request establishes the profile
   - Subsequent requests must match the established profile
   - Conflicting proxy/geo fields are rejected with a clear error
3. **Session cleanup**: When a session is evicted or deleted, its profile is cleared and can be re-established with a new configuration

### Context pool behavior
Implemented in `src/services/context-pool.ts`:
- Context eviction operates on `profileKey` (derived from `userId + sessionKey + proxy + geo`)
- Sibling sessions with different `sessionKey` values survive individual eviction
- LRU eviction respects the full profile key, not just `userId`

---

## 8) CLI proxy and geo flags

The CLI supports session-level proxy and geo configuration through dedicated flags.

### Proxy flags
```bash
camofox open <url> --proxy-profile <name>         # Use named profile
camofox open <url> --proxy-host <host>            # Raw proxy host
                   --proxy-port <port>            # Raw proxy port
                   [--proxy-username <user>]     # Optional auth
                   [--proxy-password <pass>]     # Optional auth
```

### Geo flags
```bash
camofox open <url> --geo <preset>                 # Built-in or custom preset
                   --geo-mode <mode>              # explicit-wins or proxy-locked
```

### Combined examples
```bash
# Named profile with geo preset
camofox open https://example.com --proxy-profile tokyo-exit --geo japan

# Raw proxy with proxy-locked geo
camofox open https://example.com \
  --proxy-host proxy.example.com \
  --proxy-port 8080 \
  --geo uk \
  --geo-mode proxy-locked

# Different session keys for parallel profiles
camofox open https://example.com --proxy-profile tokyo-exit --user agent1
# (different terminal/session)
camofox open https://example.com --proxy-profile london-exit --user agent1
# Both succeed because default sessionKey allows parallel sessions
```

### Environment variable fallback
CLI still respects server-level environment variables (`PROXY_HOST`, etc.) as the baseline.
Session-level flags override the environment baseline.

---

## 9) API examples

### Create tab with named proxy profile
```bash
curl -sS -X POST "http://127.0.0.1:9377/tabs" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "geo-user",
    "sessionKey": "task1",
    "url": "https://example.com",
    "proxyProfile": "tokyo-exit",
    "preset": "japan",
    "geoMode": "explicit-wins"
  }'
```

### Create tab with raw proxy fields
```bash
curl -sS -X POST "http://127.0.0.1:9377/tabs" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "geo-user",
    "sessionKey": "task2",
    "url": "https://example.com",
    "proxy": {
      "host": "proxy.example.com",
      "port": 8080,
      "username": "user",
      "password": "pass"
    },
    "geoMode": "proxy-locked"
  }'
```

### Create tab with server-level proxy baseline
```bash
# Server started with PROXY_HOST=proxy.example.com PROXY_PORT=8080
curl -sS -X POST "http://127.0.0.1:9377/tabs" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "geo-user",
    "sessionKey": "default",
    "url": "https://example.com",
    "preset": "singapore"
  }'
# Uses server-level proxy with explicit geo
```

### List all available presets
```bash
curl -sS "http://127.0.0.1:9377/presets"
```

### OpenClaw compatibility
OpenClaw `/tabs/open` endpoint accepts the same proxy/geo fields:
```bash
curl -sS -X POST "http://127.0.0.1:9377/tabs/open" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "openclaw-user",
    "listItemId": "task1",
    "url": "https://example.com",
    "proxyProfile": "london-exit",
    "geoMode": "proxy-locked"
  }'
```

---

## 10) Notes and caveats

- **Unknown preset names** return explicit errors with available options
- **Invalid proxy profiles** return errors listing available profile names
- **Session profile conflicts**: Requests with conflicting proxy/geo for an existing `userId + sessionKey` are rejected with a clear error
- **Parallel sessions**: Different `sessionKey` values allow parallel sessions with different proxy/geo configurations for the same `userId`
- **Server restart**: Session profiles are memory-only and cleared on server restart
- **Proxy validation**: Raw proxy fields are validated for required `host` and `port`; missing fields return errors
- **Geo mode default**: If `geoMode` is omitted, defaults to `explicit-wins`
- **Context restart**: If a user context already exists with a different profile, new seed overrides are rejected until the context is evicted or deleted
