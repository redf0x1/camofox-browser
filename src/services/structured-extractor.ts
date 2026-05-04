import type { Locator, Page } from 'playwright-core';
import type {
	StructuredExtractListSchema,
	StructuredExtractObjectSchema,
	StructuredExtractResult,
	StructuredExtractRootSchema,
	StructuredExtractScalarSchema,
	StructuredExtractSchema,
	StructuredScalarKind,
} from '../types';

const cssTree = require('css-tree') as {
	parse: (selector: string, options?: { context?: string; parseCustomProperty?: boolean }) => unknown;
	walk: (ast: unknown, callback: (node: any) => void) => void;
};

type CompiledStructuredExtractScalarSchema = StructuredExtractScalarSchema & {
	path: string;
};

type CompiledStructuredExtractObjectSchema = Omit<StructuredExtractObjectSchema, 'fields'> & {
	fields: Record<string, CompiledStructuredExtractSchema>;
	path: string;
};

type CompiledStructuredExtractListSchema = Omit<StructuredExtractListSchema, 'item'> & {
	item: CompiledStructuredExtractSchema;
	path: string;
};

export type CompiledStructuredExtractSchema =
	| CompiledStructuredExtractScalarSchema
	| CompiledStructuredExtractObjectSchema
	| CompiledStructuredExtractListSchema;

export type CompiledStructuredExtractRootSchema =
	| CompiledStructuredExtractObjectSchema
	| CompiledStructuredExtractListSchema;

const scalarKinds = new Set<StructuredScalarKind>(['text', 'html', 'attr', 'url', 'number']);
const joinKinds = new Set<StructuredScalarKind>(['text', 'attr', 'url']);
const scalarSchemaKeys = new Set(['kind', 'selector', 'required', 'trim', 'join', 'coerce', 'attr']);
const objectSchemaKeys = new Set(['kind', 'selector', 'required', 'fields']);
const listSchemaKeys = new Set(['kind', 'selector', 'required', 'item']);
const legacyPseudoElementNames = new Set(['before', 'after', 'first-letter', 'first-line']);
const simplePseudoClassNames = new Set([
	'-webkit-autofill',
	'active',
	'any-link',
	'autofill',
	'blank',
	'buffering',
	'checked',
	'closed',
	'default',
	'defined',
	'disabled',
	'empty',
	'enabled',
	'first-child',
	'first-of-type',
	'focus',
	'focus-visible',
	'focus-within',
	'fullscreen',
	'future',
	'hover',
	'in-range',
	'indeterminate',
	'invalid',
	'last-child',
	'last-of-type',
	'link',
	'local-link',
	'modal',
	'muted',
	'only-child',
	'open',
	'optional',
	'out-of-range',
	'past',
	'paused',
	'picture-in-picture',
	'placeholder-shown',
	'playing',
	'popover-open',
	'read-only',
	'read-write',
	'required',
	'root',
	'scope',
	'seeking',
	'stalled',
	'target',
	'target-within',
	'user-invalid',
	'user-valid',
	'valid',
	'visited',
	'volume-locked',
]);
const functionalPseudoClassNames = new Set([
	'current',
	'dir',
	'has',
	'heading',
	'host',
	'host-context',
	'is',
	'lang',
	'not',
	'nth-col',
	'nth-last-col',
	'state',
	'where',
]);

function isSupportedPseudoClass(node: { name?: string; children?: unknown[] | null }): boolean {
	const name = String(node.name || '').toLowerCase();
	if (legacyPseudoElementNames.has(name)) return true;
	if (node.children) {
		return (
			functionalPseudoClassNames.has(name) ||
			/^nth-(?:last-)?(?:child|of-type)$/.test(name)
		);
	}
	return simplePseudoClassNames.has(name);
}

export class StructuredExtractSchemaError extends Error {
	public readonly statusCode = 400;

	constructor(message: string) {
		super(message);
		this.name = 'StructuredExtractSchemaError';
	}
}

export interface StructuredScopeAdapter {
	queryAll(selector: string): Promise<StructuredScopeAdapter[]>;
	text(): Promise<string | null>;
	html(): Promise<string | null>;
	attr(name: string): Promise<string | null>;
	getBaseUrl(): string;
}

export class StructuredExtractRuntimeError extends Error {
	public readonly statusCode = 422;
	public readonly fieldPath: string;
	public readonly reason: string;

	constructor(fieldPath: string, reason: string) {
		super(reason === 'required' ? `Missing required field at ${fieldPath}` : `Structured extraction failed at ${fieldPath}`);
		this.name = 'StructuredExtractRuntimeError';
		this.fieldPath = fieldPath;
		this.reason = reason;
	}
}

function assertRecord(path: string, value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new StructuredExtractSchemaError(`${path} must be an object`);
	}
}

function assertCssSelector(path: string, selector: string | undefined): void {
	if (selector === undefined) return;
	if (typeof selector !== 'string' || selector.trim().length === 0) {
		throw new StructuredExtractSchemaError(`${path}.selector must be a non-empty string`);
	}
	const normalizedSelector = selector.trim();

	let ast: unknown;
	try {
		ast = cssTree.parse(normalizedSelector, { context: 'selectorList', parseCustomProperty: true });
	} catch {
		throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
	}

	let previousNode: any = null;
	let hasNode = false;

	cssTree.walk(ast, (node) => {
		hasNode = true;
		if (node.type === 'PseudoElementSelector') {
			const name = String(node.name || '').toLowerCase();
			if (name.startsWith('-p-')) {
				throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
			}
			throw new StructuredExtractSchemaError(
				`${path}.selector must target DOM elements; pseudo-elements are not supported`,
			);
		}

		if (node.type === 'PseudoClassSelector') {
			const name = String(node.name || '').toLowerCase();
			if (legacyPseudoElementNames.has(name)) {
				throw new StructuredExtractSchemaError(
					`${path}.selector must target DOM elements; pseudo-elements are not supported`,
				);
			}
			if (!isSupportedPseudoClass(node)) {
				throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
			}
		}

		if (node.type === 'Combinator' && previousNode === null) {
			throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
		}

		if (previousNode && previousNode.type === 'Combinator' && node.type === 'Combinator') {
			throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
		}

		previousNode = node;
	});

	if (!hasNode || previousNode?.type === 'Combinator') {
		throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
	}
}

function assertNoTransform(path: string, schema: Record<string, unknown>): void {
	if ('transform' in schema) {
		throw new StructuredExtractSchemaError(`${path}.transform is not supported`);
	}
}

function assertAllowedKeys(path: string, schema: Record<string, unknown>, allowedKeys: Set<string>): void {
	for (const key of Object.keys(schema)) {
		if (!allowedKeys.has(key)) {
			throw new StructuredExtractSchemaError(`${path}.${key} is not supported`);
		}
	}
}

function assertBooleanOption(path: string, key: string, value: unknown): void {
	if (value !== undefined && typeof value !== 'boolean') {
		throw new StructuredExtractSchemaError(`${path}.${key} must be a boolean`);
	}
}

function assertStringOption(path: string, key: string, value: unknown): void {
	if (value !== undefined && typeof value !== 'string') {
		throw new StructuredExtractSchemaError(`${path}.${key} must be a string`);
	}
}

function assertNonEmptyStringOption(path: string, key: string, value: unknown): void {
	assertStringOption(path, key, value);
	if (typeof value === 'string' && value.trim().length === 0) {
		throw new StructuredExtractSchemaError(`${path}.${key} must be a non-empty string`);
	}
}

function assertScalarOptionTypes(path: string, schema: StructuredExtractScalarSchema): void {
	assertBooleanOption(path, 'required', schema.required);
	assertBooleanOption(path, 'trim', schema.trim);
	assertStringOption(path, 'join', schema.join);
	assertStringOption(path, 'attr', schema.attr);
	if (schema.attr !== undefined && schema.kind !== 'attr' && schema.kind !== 'url') {
		throw new StructuredExtractSchemaError(`${path}.attr is only supported for kind "attr" and "url"`);
	}
	if (schema.coerce !== undefined && schema.coerce !== 'number' && schema.coerce !== 'url') {
		throw new StructuredExtractSchemaError(`${path}.coerce must be "number" or "url"`);
	}
	if (schema.kind === 'attr' && schema.attr !== undefined) {
		assertNonEmptyStringOption(path, 'attr', schema.attr);
	}
	if (schema.kind === 'url' && schema.attr !== undefined) {
		assertNonEmptyStringOption(path, 'attr', schema.attr);
	}
}

function assertContainerOptionTypes(
	path: string,
	schema: StructuredExtractObjectSchema | StructuredExtractListSchema,
): void {
	assertBooleanOption(path, 'required', schema.required);
}

function validateScalarSchema(path: string, schema: StructuredExtractScalarSchema): CompiledStructuredExtractScalarSchema {
	const schemaRecord = schema as unknown as Record<string, unknown>;
	assertCssSelector(path, schema.selector);
	assertNoTransform(path, schemaRecord);
	assertAllowedKeys(path, schemaRecord, scalarSchemaKeys);
	assertScalarOptionTypes(path, schema);

	if (!scalarKinds.has(schema.kind)) {
		throw new StructuredExtractSchemaError(`${path}.kind must be one of text, html, attr, url, or number`);
	}
	if (schema.kind === 'attr' && !schema.attr) {
		throw new StructuredExtractSchemaError(`${path}.attr is required for kind "attr"`);
	}
	if (schema.join !== undefined && !joinKinds.has(schema.kind)) {
		throw new StructuredExtractSchemaError(`${path}.join is only supported for text, attr, and url fields`);
	}

	return {
		kind: schema.kind,
		selector: schema.selector,
		required: schema.required,
		trim: schema.trim,
		join: schema.join,
		coerce: schema.coerce,
		attr: schema.kind === 'url' ? schema.attr ?? 'href' : schema.attr,
		path,
	};
}

function validateStructuredExtractNode(
	schema: StructuredExtractSchema,
	path = 'schema',
): CompiledStructuredExtractSchema {
	assertRecord(path, schema);

	if (schema.kind === 'object') {
		const schemaRecord = schema as unknown as Record<string, unknown>;
		assertCssSelector(path, schema.selector);
		assertNoTransform(path, schemaRecord);
		assertAllowedKeys(path, schemaRecord, objectSchemaKeys);
		assertContainerOptionTypes(path, schema);
		assertRecord(`${path}.fields`, schema.fields);

		const fields = Object.fromEntries(
			Object.entries(schema.fields).map(([key, value]) => [
				key,
				validateStructuredExtractNode(value as StructuredExtractSchema, `${path}.fields.${key}`),
			]),
		);
		return {
			kind: 'object',
			selector: schema.selector,
			required: schema.required,
			fields,
			path,
		};
	}

	if (schema.kind === 'list') {
		const schemaRecord = schema as unknown as Record<string, unknown>;
		assertCssSelector(path, schema.selector);
		assertNoTransform(path, schemaRecord);
		assertAllowedKeys(path, schemaRecord, listSchemaKeys);
		assertContainerOptionTypes(path, schema);
		return {
			kind: 'list',
			selector: schema.selector,
			required: schema.required,
			item: validateStructuredExtractNode(schema.item, `${path}.item`),
			path,
		};
	}

	return validateScalarSchema(path, schema);
}

export function validateStructuredExtractSchema(
	schema: StructuredExtractRootSchema,
): CompiledStructuredExtractRootSchema {
	assertRecord('schema', schema);
	if (schema.kind !== 'object' && schema.kind !== 'list') {
		throw new StructuredExtractSchemaError('schema.kind must be "object" or "list" at the root');
	}
	return validateStructuredExtractNode(schema, 'schema') as CompiledStructuredExtractRootSchema;
}

export function buildFieldPath(path: string, key: string | number): string {
	if (typeof key === 'number') {
		return `${path}[${key}]`;
	}
	return `${path}.${key}`;
}

export function createLocatorScope(locator: Locator, baseUrl: string): StructuredScopeAdapter {
	return {
		async queryAll(selector: string): Promise<StructuredScopeAdapter[]> {
			const matches = locator.locator(selector);
			const count = await matches.count();
			const scopes: StructuredScopeAdapter[] = [];
			for (let index = 0; index < count; index += 1) {
				scopes.push(createLocatorScope(matches.nth(index), baseUrl));
			}
			return scopes;
		},
		async text(): Promise<string | null> {
			return locator.textContent();
		},
		async html(): Promise<string | null> {
			return locator.evaluate((node) => (node as { innerHTML?: string }).innerHTML ?? null);
		},
		async attr(name: string): Promise<string | null> {
			return locator.getAttribute(name);
		},
		getBaseUrl(): string {
			return baseUrl;
		},
	};
}

function normalizeStringValue(value: string | null, trim?: boolean): string | null {
	if (value === null || value === undefined) return null;
	const normalized = trim ? value.trim() : value;
	return normalized.length > 0 ? normalized : null;
}

function coerceNumberValue(value: string | null): number | null {
	if (value === null) return null;
	const normalized = value.replace(/,/g, '');
	const coerced = Number(normalized);
	return Number.isFinite(coerced) ? coerced : null;
}

function coerceUrlValue(value: string | null, baseUrl: string): string | null {
	if (value === null) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

async function getSelectedScopes(
	scope: StructuredScopeAdapter,
	selector?: string,
): Promise<StructuredScopeAdapter[]> {
	if (!selector) return [scope];
	return scope.queryAll(selector);
}

function throwRequiredRuntimeError(fieldPath: string): never {
	throw new StructuredExtractRuntimeError(fieldPath, 'required');
}

async function extractRawScalarValue(
	scope: StructuredScopeAdapter,
	schema: CompiledStructuredExtractScalarSchema,
): Promise<string | null> {
	let rawValue: string | null;

	if (schema.kind === 'html') {
		rawValue = normalizeStringValue(await scope.html(), schema.trim);
	} else if (schema.kind === 'attr' || schema.kind === 'url') {
		rawValue = normalizeStringValue(await scope.attr(schema.attr || 'href'), schema.trim);
	} else {
		rawValue = normalizeStringValue(await scope.text(), schema.trim);
	}

	return rawValue;
}

function coerceScalarValue(
	rawValue: string | null,
	schema: CompiledStructuredExtractScalarSchema,
	baseUrl: string,
): string | number | null {
	if (schema.kind === 'number' || schema.coerce === 'number') {
		return coerceNumberValue(rawValue);
	}
	if (schema.kind === 'url' || schema.coerce === 'url') {
		return coerceUrlValue(rawValue, baseUrl);
	}
	return rawValue;
}

async function extractScalarFromScope(
	scope: StructuredScopeAdapter,
	schema: CompiledStructuredExtractScalarSchema,
	fieldPath: string,
): Promise<string | number | null> {
	const matches = await getSelectedScopes(scope, schema.selector);
	if (matches.length === 0) {
		if (schema.required) {
			throwRequiredRuntimeError(fieldPath);
		}
		return null;
	}

	if (schema.join !== undefined) {
		const values: string[] = [];
		for (const match of matches) {
			const value = await extractRawScalarValue(match, schema);
			if (value !== null) {
				values.push(value);
			}
		}
		if (values.length === 0) {
			if (schema.required) {
				throwRequiredRuntimeError(fieldPath);
			}
			return null;
		}
		return coerceScalarValue(values.join(schema.join), schema, scope.getBaseUrl());
	}

	const value = coerceScalarValue(await extractRawScalarValue(matches[0], schema), schema, scope.getBaseUrl());
	if (value === null && schema.required) {
		throwRequiredRuntimeError(fieldPath);
	}
	return value;
}

async function extractCompiledFromScope(
	scope: StructuredScopeAdapter,
	schema: CompiledStructuredExtractSchema,
	fieldPath: string,
): Promise<unknown> {
	if (schema.kind === 'object') {
		const matches = await getSelectedScopes(scope, schema.selector);
		if (matches.length === 0) {
			if (schema.required) {
				throwRequiredRuntimeError(fieldPath);
			}
			return null;
		}

		const objectScope = matches[0];
		const output: Record<string, unknown> = {};
		for (const [key, childSchema] of Object.entries(schema.fields)) {
			output[key] = await extractCompiledFromScope(objectScope, childSchema, buildFieldPath(fieldPath, key));
		}
		return output;
	}

	if (schema.kind === 'list') {
		const matches = await getSelectedScopes(scope, schema.selector);
		if (matches.length === 0) {
			if (schema.required) {
				throwRequiredRuntimeError(fieldPath);
			}
			return [];
		}

		const values = [];
		for (let index = 0; index < matches.length; index += 1) {
			values.push(
				await extractCompiledFromScope(matches[index], schema.item, buildFieldPath(fieldPath, index)),
			);
		}
		return values;
	}

	return extractScalarFromScope(scope, schema, fieldPath);
}

async function countRootMatches(
	scope: StructuredScopeAdapter,
	schema: CompiledStructuredExtractRootSchema,
): Promise<number> {
	if (!schema.selector) {
		return 1;
	}
	const matches = await scope.queryAll(schema.selector);
	return matches.length;
}

async function extractCompiledRootFromScope(
	scope: StructuredScopeAdapter,
	schema: CompiledStructuredExtractRootSchema,
	path = 'data',
): Promise<unknown> {
	return extractCompiledFromScope(scope, schema, path);
}

export async function extractStructuredFromScope(
	scope: StructuredScopeAdapter,
	schema: StructuredExtractRootSchema,
	path = 'data',
): Promise<unknown> {
	return extractCompiledRootFromScope(scope, validateStructuredExtractSchema(schema), path);
}

export async function extractStructuredData(
	page: Page,
	schema: StructuredExtractRootSchema,
): Promise<StructuredExtractResult> {
	const start = Date.now();
	const compiledSchema = validateStructuredExtractSchema(schema);
	const rootScope = createLocatorScope(page.locator('html'), page.url());
	const matchedRoots = await countRootMatches(rootScope, compiledSchema);
	const data = await extractCompiledRootFromScope(rootScope, compiledSchema, 'data');

	return {
		ok: true,
		data,
		metadata: {
			extractionTimeMs: Date.now() - start,
			matchedRoots,
		},
	};
}
