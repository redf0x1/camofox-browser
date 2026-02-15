# Contributing to CamoFox Browser Server

## Development Setup

1. Clone: `git clone https://github.com/redf0x1/camofox-browser.git`
2. Install: `npm install`
3. Build: `npm run build`
4. Dev mode: `npm run dev` (hot reload with `tsx`)
5. Test: `npm test`
6. Lint: `npm run lint`

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
