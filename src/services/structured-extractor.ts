import type {
	StructuredExtractListSchema,
	StructuredExtractObjectSchema,
	StructuredExtractResult,
	StructuredExtractRootSchema,
	StructuredExtractScalarSchema,
	StructuredExtractSchema,
	StructuredScalarKind,
} from '../types';

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
const disallowedSelectorPatterns = [
	/^internal:/i,
	/>>/,
	/:has-text\(/i,
	/:(?:text|text-is|text-matches|nth-match|visible|near|right-of|left-of|above|below)\b/i,
	/::[a-z-]+/i,
	/[>+~]\s*$/,
];
const allowedPseudoClasses = new Set([
	'active',
	'checked',
	'default',
	'defined',
	'dir',
	'disabled',
	'empty',
	'enabled',
	'first-child',
	'first-of-type',
	'focus',
	'focus-visible',
	'focus-within',
	'has',
	'hover',
	'indeterminate',
	'in-range',
	'invalid',
	'is',
	'lang',
	'last-child',
	'last-of-type',
	'link',
	'not',
	'nth-child',
	'nth-last-child',
	'nth-last-of-type',
	'nth-of-type',
	'only-child',
	'only-of-type',
	'optional',
	'out-of-range',
	'placeholder-shown',
	'read-only',
	'read-write',
	'required',
	'root',
	'scope',
	'target',
	'valid',
	'visited',
	'where',
]);

export class StructuredExtractSchemaError extends Error {
	public readonly statusCode = 400;

	constructor(message: string) {
		super(message);
		this.name = 'StructuredExtractSchemaError';
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
	if (/::[a-z-]+/i.test(normalizedSelector) && !normalizedSelector.includes('::-p-')) {
		throw new StructuredExtractSchemaError(
			`${path}.selector must target DOM elements; pseudo-elements are not supported`,
		);
	}
	if (
		/^\d/.test(normalizedSelector) ||
		normalizedSelector.startsWith('//') ||
		normalizedSelector.startsWith('.//') ||
		/^[a-z][a-z-]*=/i.test(normalizedSelector) ||
		normalizedSelector.includes('::-p-') ||
		disallowedSelectorPatterns.some((pattern) => pattern.test(normalizedSelector)) ||
		hasUnsupportedPseudoClass(normalizedSelector) ||
		!isBalancedCssSelector(normalizedSelector)
	) {
		throw new StructuredExtractSchemaError(`${path}.selector must be a CSS selector`);
	}
}

function hasUnsupportedPseudoClass(selector: string): boolean {
	let activeQuote: '"' | "'" | null = null;
	let escaped = false;
	let bracketDepth = 0;

	for (let index = 0; index < selector.length; index += 1) {
		const char = selector[index];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === '\\') {
			escaped = true;
			continue;
		}

		if (activeQuote) {
			if (char === activeQuote) activeQuote = null;
			continue;
		}

		if (char === '"' || char === "'") {
			activeQuote = char;
			continue;
		}

		if (char === '[') {
			bracketDepth += 1;
			continue;
		}

		if (char === ']') {
			bracketDepth = Math.max(0, bracketDepth - 1);
			continue;
		}

		if (bracketDepth > 0 || char !== ':' || selector[index + 1] === ':') {
			continue;
		}

		const match = selector.slice(index + 1).match(/^([a-z-]+)/i);
		if (!match) return true;
		if (!allowedPseudoClasses.has(match[1].toLowerCase())) {
			return true;
		}
	}

	return false;
}

function isBalancedCssSelector(selector: string): boolean {
	const stack: string[] = [];
	let activeQuote: '"' | "'" | null = null;
	let escaped = false;

	for (const char of selector) {
		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === '\\') {
			escaped = true;
			continue;
		}

		if (activeQuote) {
			if (char === activeQuote) {
				activeQuote = null;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			activeQuote = char;
			continue;
		}

		if (char === '[' || char === '(') {
			stack.push(char);
			continue;
		}

		if (char === ']') {
			if (stack.pop() !== '[') return false;
			continue;
		}

		if (char === ')') {
			if (stack.pop() !== '(') return false;
		}
	}

	return !activeQuote && stack.length === 0;
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

export async function extractStructuredData(): Promise<StructuredExtractResult> {
	throw new Error('Not implemented yet');
}
