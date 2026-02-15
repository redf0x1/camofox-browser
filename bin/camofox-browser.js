#!/usr/bin/env node

// Minimal CLI entrypoint for running the server via `npx camofox-browser`.
// The server starts listening as a side effect of importing the built entry.

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
	const pkg = require('../package.json');
	console.log(`
CamoFox Browser Server v${pkg.version}
Anti-detection browser server for AI agents

Usage:
	camofox-browser [options]

Options:
	--help, -h     Show this help message
	--version, -v  Show version number

Environment Variables:
	PORT              Server port (default: 9377)
	CAMOFOX_API_KEY   API key for protected endpoints
	CAMOFOX_HEADLESS  Run browser headless (default: false)
	CAMOFOX_PROXY     Proxy URL for browser

Documentation:
	https://github.com/redf0x1/camofox-browser
`);
	process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
	const pkg = require('../package.json');
	console.log(pkg.version);
	process.exit(0);
}

require('../dist/src/server.js');
