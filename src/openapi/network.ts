import type { OpenAPIV3 } from 'openapi-types';

const networkKey: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const headers: OpenAPIV3.SchemaObject = {
	type: 'array',
	items: {
		type: 'object', required: ['name', 'value'],
		properties: { name: { type: 'string' }, value: { type: 'string' } },
	},
};
const state: OpenAPIV3.SchemaObject = { type: 'string', enum: ['ready', 'recording', 'stopped'] };

export const networkCaptureOptions: OpenAPIV3.SchemaObject = {
	type: 'object',
	description: 'Opt in before initial navigation. For an existing session capture, set join and send its key in the X-Camofox-Network-Key header.',
	additionalProperties: false,
	properties: {
		scope: { type: 'string', enum: ['tab', 'session'], default: 'tab' },
		start: { type: 'boolean', default: true },
		join: { type: 'boolean', default: false },
		captureBodies: { type: 'boolean', default: false },
	},
};

export const networkKeyResponse: OpenAPIV3.SchemaObject = {
	...networkKey,
	description: 'Private, expiring access key returned only when a capture is created.',
};

const captureAuth: OpenAPIV3.SecurityRequirementObject[] = [
	{ networkKey: [], bearerAuth: [] },
	{ networkKey: [] },
];

const owner: OpenAPIV3.ParameterObject = {
	name: 'userId', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 256 },
};

function operation(
	summary: string,
	schema: OpenAPIV3.SchemaObject,
	parameters: OpenAPIV3.ParameterObject[] = [],
): OpenAPIV3.OperationObject {
	return {
		summary,
		tags: ['Network'],
		description: 'A browser bearer token is also required when the server is configured with an API key.',
		security: captureAuth,
		parameters: [owner, ...parameters],
		responses: {
			'200': { description: summary, content: { 'application/json': { schema } } },
			'400': { description: 'Invalid user or capture parameters' },
			'403': { description: 'Invalid browser server authentication' },
			'404': { description: 'Capture or request unavailable' },
			'409': { description: 'Capture cannot transition to the requested state' },
		},
	};
}

const request: OpenAPIV3.SchemaObject = {
	type: 'object',
	required: ['id', 'tabId', 'startedAt', 'method', 'url', 'resourceType', 'state'],
	properties: {
		id: { type: 'integer', minimum: 1 },
		tabId: { type: 'string' },
		startedAt: { type: 'number', description: 'Epoch milliseconds' },
		method: { type: 'string' },
		url: { type: 'string' },
		resourceType: { type: 'string' },
		requestHeaders: headers,
		responseHeaders: headers,
		state: { type: 'string', enum: ['pending', 'finished', 'failed'] },
		redirectedFrom: { type: 'integer', minimum: 1 },
		redirectUrl: { type: 'string' },
		status: { type: 'integer' },
		mimeType: { type: 'string' },
		durationMs: { type: 'number', minimum: 0 },
		responseSize: { type: 'number', minimum: 0, description: 'Encoded response body bytes when available' },
		failure: { type: 'string' },
		bodyState: { type: 'string', enum: ['pending', 'skipped', 'available', 'unavailable'] },
	},
};

const stateResponse: OpenAPIV3.SchemaObject = {
	type: 'object', required: ['state'], properties: { state },
};

export const networkPaths: OpenAPIV3.PathsObject = {
	'/network/capabilities': {
		get: {
			tags: ['Network'],
			summary: 'Discover network capture support',
			responses: { '200': {
				description: 'Network capture capabilities',
				content: { 'application/json': { schema: {
					type: 'object', required: ['captureVersion', 'har', 'interception', 'bodyCapture'],
					properties: {
						captureVersion: { type: 'integer', enum: [1] },
						har: { type: 'boolean', enum: [true] },
						interception: { type: 'boolean' },
						bodyCapture: { type: 'boolean' },
					},
				} } },
			} },
		},
	},
	'/network/capture/start': { post: operation('Start a prepared capture', stateResponse) },
	'/network/capture/stop': { post: operation('Stop network capture', stateResponse) },
	'/network/requests': {
		get: operation('List captured network requests', {
			type: 'object', required: ['state', 'dropped', 'requests', 'nextCursor'],
			properties: {
				state,
				dropped: { type: 'integer', minimum: 0 },
				requests: { type: 'array', items: request },
				nextCursor: { anyOf: [{ type: 'integer' }, { enum: [null] }] },
			},
		}, [
			{ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
			{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 } },
		]),
	},
	'/network/requests/{id}': {
		get: operation('Inspect a captured network request', {
			...request, properties: { ...request.properties, body: { type: 'string' } },
		}, [
			{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
			{ name: 'includeBody', in: 'query', schema: { type: 'boolean', default: false } },
		]),
	},
	'/network/intercept': {
		put: {
			...operation('Replace exact-match fetch and XHR interception rules', {
				type: 'object', required: ['ruleCount'], properties: { ruleCount: { type: 'integer' } },
			}),
			security: [{ networkKey: [], bearerAuth: [] }],
			requestBody: {
				required: true,
				content: { 'application/json': { schema: {
					type: 'object', required: ['rules'], properties: {
						rules: {
							type: 'array', maxItems: 4, items: {
								oneOf: [
									{
										type: 'object', additionalProperties: false, required: ['url', 'method', 'action'],
										properties: {
											url: { type: 'string', format: 'uri', maxLength: 1024, description: 'Exact HTTP(S) URL without credentials or a fragment.' },
											method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
											action: { type: 'string', enum: ['abort'] },
										},
									},
									{
										type: 'object', additionalProperties: false, required: ['url', 'method', 'action', 'body', 'status', 'contentType'],
										properties: {
											url: { type: 'string', format: 'uri', maxLength: 1024, description: 'Exact HTTP(S) URL without credentials or a fragment.' },
											method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
											action: { type: 'string', enum: ['fulfill'] },
											body: { type: 'string', maxLength: 16 * 1024, description: 'Static UTF-8 text, at most 16384 encoded bytes (not characters).' },
											status: { oneOf: [
												{ type: 'integer', minimum: 200, maximum: 203 },
												{ type: 'integer', minimum: 206, maximum: 299 },
												{ type: 'integer', minimum: 400, maximum: 599 },
											] },
											contentType: { type: 'string', enum: ['application/json', 'text/plain'] },
										},
									},
								],
							},
						},
					},
				} } },
			},
		},
	},

	'/network/har': {
		get: operation('Export sanitized HAR 1.2', {
			type: 'object', required: ['log'], properties: { log: { type: 'object' } },
		}),
	},
};
