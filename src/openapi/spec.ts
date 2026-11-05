import fs from 'node:fs';
import { resolve } from 'node:path';
import type { OpenAPIV3_1 } from 'openapi-types';
import { networkCaptureOptions, networkKeyResponse, networkPaths } from './network';

/**
 * OpenAPI 3.1.0 specification for Camofox Browser API
 * 
 * This spec documents the current route surface for core and OpenClaw endpoints.
 * It provides a maintainable, realistic subset covering the documented API surface.
 */

// Read version from package.json, probing both src and dist paths
const PKG_VERSION = (() => {
	// Probe plausible paths for package.json (works from both src/openapi/spec.ts and dist/src/openapi/spec.js)
	const possiblePaths = [
		resolve(__dirname, '../../../package.json'),  // From dist/src/openapi/spec.js
		resolve(__dirname, '../../package.json'),     // From src/openapi/spec.ts (via src root)
	];
	
	for (const pkgPath of possiblePaths) {
		try {
			if (fs.existsSync(pkgPath)) {
				const raw = fs.readFileSync(pkgPath, 'utf8');
				const pkg = JSON.parse(raw) as { version?: unknown };
				if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
					return pkg.version;
				}
			}
		} catch {
			// Try next path
		}
	}
	
	throw new Error('Unable to resolve server version from package.json');
})();

export function buildOpenapiSpec(serverUrl = '.'): OpenAPIV3_1.Document {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Camofox Browser API',
			version: PKG_VERSION,
			description:
				'Camofox is a fingerprint-resistant browser automation server powered by Camoufox. ' +
				'It provides both a core REST API and OpenClaw-compatible endpoints for browser automation tasks.',
			license: {
				name: 'MIT',
				url: 'https://github.com/redf0x1/camofox-browser/blob/main/LICENSE',
			},
		},
		servers: [
			{
				url: serverUrl,
				description: 'Current server origin',
			},
		],
		paths: {
		...networkPaths,
		'/health': {
			get: {
				summary: 'Health check',
				description: 'Returns server health status and basic statistics',
				tags: ['Core'],
				responses: {
					'200': {
						description: 'Server is healthy',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										running: { type: 'boolean' },
										engine: { type: 'string', example: 'camoufox' },
										version: { type: 'string' },
										browserConnected: { type: 'boolean' },
										poolSize: { type: 'number' },
										activeUserIds: { type: 'array', items: { type: 'string' } },
										profileDirsTotal: { type: 'number' },
									},
									required: ['ok', 'running', 'engine', 'version', 'browserConnected', 'poolSize', 'activeUserIds', 'profileDirsTotal'],
								},
							},
						},
					},
					'500': {
						description: 'Server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean', enum: [false] },
										error: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		'/presets': {
			get: {
				summary: 'List available presets',
				description: 'Returns all available browser context presets',
				tags: ['Core'],
				responses: {
					'200': {
						description: 'Map of preset names to preset configurations',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										presets: {
											type: 'object',
											additionalProperties: {
												type: 'object',
												properties: {
													locale: { type: 'string' },
													timezoneId: { type: 'string' },
													geolocation: { $ref: '#/components/schemas/GeolocationConfig' },
												},
											},
										},
									},
									required: ['presets'],
								},
							},
						},
					},
				},
			},
		},
		'/tabs': {
			post: {
				summary: 'Create a managed tab',
				description: 'Create a tab with an optional initial URL and opt-in network capture.',
				tags: ['Core'],
				security: [{ bearerAuth: [] }, {}],
				parameters: [{
					name: 'X-Camofox-Network-Key', in: 'header', schema: { type: 'string' },
					description: 'Required when joining an existing session capture.',
				}],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object', required: ['userId'],
						anyOf: [{ required: ['sessionKey'] }, { required: ['listItemId'] }],
						properties: {
							userId: { type: 'string' }, sessionKey: { type: 'string' }, listItemId: { type: 'string' },
							url: { type: 'string' }, networkCapture: networkCaptureOptions,
						},
					} } },
				},
				responses: {
					'200': { description: 'Created tab', content: { 'application/json': { schema: {
						type: 'object', required: ['tabId', 'url'],
						properties: { tabId: { type: 'string' }, url: { type: 'string' }, networkKey: networkKeyResponse },
					} } } },
					'400': { description: 'Invalid request' },
					'403': { description: 'Invalid browser server authentication' },
					'404': { description: 'Capture unavailable' },
					'409': { description: 'Session or capture conflict' },
					'429': { description: 'Tab or capture capacity reached' },
				},
			},
			get: {
				summary: 'List tabs for a user',
				description: 'Returns all active tabs for the specified user',
				tags: ['Core'],
				parameters: [
					{
						name: 'userId',
						in: 'query',
						schema: { type: 'string' },
						required: false,
						description: 'User ID to filter tabs',
					},
				],
				responses: {
					'200': {
						description: 'List of tabs',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										running: { type: 'boolean' },
										tabs: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													targetId: { type: 'string' },
													tabId: { type: 'string' },
													url: { type: 'string' },
													title: { type: 'string' },
													listItemId: { type: 'string' },
												},
												required: ['targetId', 'tabId', 'url', 'title', 'listItemId'],
											},
										},
									},
									required: ['running', 'tabs'],
								},
							},
						},
					},
					'500': {
						description: 'Server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		'/tabs/{tabId}/navigate': {
			post: {
				summary: 'Navigate tab to URL',
				description: 'Navigate the specified tab to a URL, macro, or search query. Either url or macro is required.',
				tags: ['Core'],
				security: [{ bearerAuth: [] }],
				parameters: [
					{
						name: 'tabId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
						description: 'Tab ID',
					},
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									userId: { type: 'string' },
									url: { type: 'string' },
									macro: { type: 'string' },
									query: { type: 'string' },
								},
								required: ['userId'],
								anyOf: [
									{ required: ['url'] },
									{ required: ['macro'] },
								],
							},
						},
					},
				},
				responses: {
					'200': {
						description: 'Navigation successful',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										url: { type: 'string' },
									},
									required: ['ok', 'url'],
								},
							},
						},
					},
					'403': {
						description: 'Forbidden - Invalid or missing API key',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Forbidden'] },
									},
								},
							},
						},
					},
				},
			},
		},
		'/tabs/{tabId}/snapshot': {
			get: {
				summary: 'Get page snapshot',
				description: 'Returns a text snapshot of the current page',
				tags: ['Core'],
				parameters: [
					{
						name: 'tabId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
					{
						name: 'userId',
						in: 'query',
						required: true,
						schema: { type: 'string' },
					},
					{
						name: 'offset',
						in: 'query',
						schema: { type: 'string' },
					},
				],
				responses: {
					'200': {
						description: 'Snapshot retrieved',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										url: { type: 'string' },
										snapshot: { type: 'string' },
										refsCount: { type: 'number' },
										offset: { type: 'number' },
										truncated: { type: 'boolean' },
										totalChars: { type: 'number' },
										hasMore: { type: 'boolean' },
										nextOffset: {
											anyOf: [{ type: 'number' }, { enum: [null] }],
										},
									},
									required: ['url', 'snapshot', 'refsCount', 'offset', 'truncated', 'totalChars', 'hasMore', 'nextOffset'],
								},
							},
						},
					},
				},
			},
		},
		'/tabs/{tabId}/click': {
			post: {
				summary: 'Click element',
				description: 'Click an element by ref or selector. Either ref or selector is required.',
				tags: ['Core'],
				security: [{ bearerAuth: [] }],
				parameters: [
					{
						name: 'tabId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									userId: { type: 'string' },
									ref: { type: 'string' },
									selector: { type: 'string' },
								},
								required: ['userId'],
								anyOf: [
									{ required: ['ref'] },
									{ required: ['selector'] },
								],
							},
						},
					},
				},
				responses: {
					'200': {
						description: 'Click successful',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										url: { type: 'string' },
										downloads: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													id: { type: 'string' },
													filename: { type: 'string' },
													status: { type: 'string' },
													size: { type: 'number' },
												},
												required: ['id', 'filename', 'status', 'size'],
											},
										},
									},
									required: ['ok', 'url'],
								},
							},
						},
					},
					'403': {
						description: 'Forbidden - Invalid or missing API key',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Forbidden'] },
									},
								},
							},
						},
					},
				},
			},
		},
		'/tabs/open': {
			post: {
				summary: 'Open new tab (OpenClaw)',
				description: 'Create a new browser tab with optional URL and configuration',
				tags: ['OpenClaw'],
				security: [{ bearerAuth: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									url: { type: 'string' },
									userId: { type: 'string' },
									networkCapture: networkCaptureOptions,
									listItemId: { type: 'string' },
									proxyProfile: { type: 'string' },
									proxy: {
										type: 'object',
										properties: {
											host: { type: 'string' },
											port: { type: 'string' },
											username: { type: 'string' },
											password: { type: 'string' },
										},
									},
									geoMode: { type: 'string', enum: ['explicit-wins', 'proxy-locked'] },
								},
								required: ['url', 'userId'],
							},
						},
					},
				},
				responses: {
					'200': {
						description: 'Tab created and navigated',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										targetId: { type: 'string' },
										tabId: { type: 'string' },
										url: { type: 'string' },
										title: { type: 'string' },
										networkKey: networkKeyResponse,
									},
									required: ['ok', 'targetId', 'tabId', 'url', 'title'],
								},
							},
						},
					},
					'400': {
						description: 'Bad request - Missing required fields or invalid URL',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string' },
									},
								},
							},
						},
					},
					'403': {
						description: 'Forbidden - Invalid or missing API key',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Forbidden'] },
									},
								},
							},
						},
					},
					'409': {
						description: 'Conflict - No canonical profile or session profile conflict',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string' },
										message: { type: 'string' },
									},
								},
							},
						},
					},
					'429': {
						description: 'Too many tabs - Maximum tabs per session reached',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Maximum tabs per session reached'] },
									},
								},
							},
						},
					},
				},
			},
		},
		'/navigate': {
			post: {
				summary: 'Navigate (OpenClaw)',
				description: 'Navigate to a URL, macro, or search query. Either url or macro is required.',
				tags: ['OpenClaw'],
				security: [{ bearerAuth: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									targetId: { type: 'string' },
									url: { type: 'string' },
									macro: { type: 'string' },
									query: { type: 'string' },
									userId: { type: 'string' },
								},
								required: ['targetId', 'userId'],
								anyOf: [
									{ required: ['url'] },
									{ required: ['macro'] },
								],
							},
						},
					},
				},
				responses: {
					'200': {
						description: 'Navigation successful',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										targetId: { type: 'string' },
										url: { type: 'string' },
									},
									required: ['ok', 'targetId', 'url'],
								},
							},
						},
					},
					'403': {
						description: 'Forbidden - Invalid or missing API key',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Forbidden'] },
									},
								},
							},
						},
					},
				},
			},
		},
		'/stop': {
			post: {
				summary: 'Stop server (OpenClaw)',
				description: 'Stop the browser server and close all sessions',
				tags: ['OpenClaw'],
				security: [{ adminKey: [] }],
				responses: {
					'200': {
						description: 'Server stopped successfully',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										stopped: { type: 'boolean' },
										profile: { type: 'string', example: 'camoufox' },
									},
									required: ['ok', 'stopped', 'profile'],
								},
							},
						},
					},
					'403': {
						description: 'Forbidden - Invalid or missing admin key',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										error: { type: 'string', enum: ['Forbidden'] },
									},
								},
							},
						},
					},
					'500': {
						description: 'Server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean', enum: [false] },
										error: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		'/snapshot': {
			get: {
				summary: 'Get snapshot (OpenClaw)',
				description: 'Get a text snapshot of the current page',
				tags: ['OpenClaw'],
				parameters: [
					{
						name: 'targetId',
						in: 'query',
						required: true,
						schema: { type: 'string' },
					},
					{
						name: 'userId',
						in: 'query',
						required: true,
						schema: { type: 'string' },
					},
					{
						name: 'format',
						in: 'query',
						schema: { type: 'string' },
					},
					{
						name: 'offset',
						in: 'query',
						schema: { type: 'string' },
					},
				],
				responses: {
					'200': {
						description: 'Snapshot retrieved',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										format: { type: 'string', enum: ['aria'] },
										targetId: { type: 'string' },
										url: { type: 'string' },
										snapshot: { type: 'string' },
										refsCount: { type: 'number' },
										offset: { type: 'number' },
										truncated: { type: 'boolean' },
										totalChars: { type: 'number' },
										hasMore: { type: 'boolean' },
										nextOffset: {
											anyOf: [{ type: 'number' }, { enum: [null] }],
										},
									},
									required: ['ok', 'format', 'targetId', 'url', 'snapshot', 'refsCount', 'offset', 'truncated', 'totalChars', 'hasMore', 'nextOffset'],
								},
							},
						},
					},
				},
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: 'http',
				scheme: 'bearer',
				description: 'API key passed as Bearer token in Authorization header',
			},
			networkKey: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Camofox-Network-Key',
			},
			adminKey: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Admin-Key',
				description: 'Admin key for privileged operations',
			},
		},
		schemas: {
			GeolocationConfig: {
				type: 'object',
				properties: {
					latitude: { type: 'number' },
					longitude: { type: 'number' },
				},
				required: ['latitude', 'longitude'],
			},
			ViewportConfig: {
				type: 'object',
				properties: {
					width: { type: 'number' },
					height: { type: 'number' },
				},
				required: ['width', 'height'],
			},
			TabState: {
				type: 'object',
				properties: {
					tabId: { type: 'string' },
					url: { type: 'string' },
					title: { type: 'string' },
					toolCalls: { type: 'number' },
				},
			},
		},
		},
		tags: [
			{
				name: 'Core',
				description: 'Core Camofox Browser API endpoints',
			},
			{
				name: 'OpenClaw',
				description: 'OpenClaw-compatible browser automation endpoints',
			},
		],
	};
}

export const openapiSpec = buildOpenapiSpec();
