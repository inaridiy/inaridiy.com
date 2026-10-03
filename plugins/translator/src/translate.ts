/**
 * Pure translation helpers: Portable Text traversal, source hashing,
 * model-reply parsing, and the plugin<->workflow job contract. No EmDash
 * imports so this stays testable and importable from the Worker entry
 * (TranslatorWorkflow) as well as the plugin sandbox entry.
 */

interface PortableTextSpanLike {
	_type?: string;
	text?: unknown;
	marks?: unknown;
}

interface PortableTextBlockLike {
	_type?: string;
	style?: string;
	children?: PortableTextSpanLike[];
}

/** Marks whose spans must not be translated (inline code, etc.). */
const SKIP_MARKS = new Set(["code"]);

function isTranslatableSpan(span: PortableTextSpanLike): boolean {
	if (span._type !== "span" || typeof span.text !== "string") return false;
	if (span.text.trim() === "") return false;
	if (Array.isArray(span.marks) && span.marks.some((m) => SKIP_MARKS.has(String(m)))) {
		return false;
	}
	return true;
}

/**
 * Deep-clone Portable Text blocks and collect references to every
 * translatable span in the clone. Only `_type: "block"` children are
 * touched; code blocks, images, and unknown block types pass through
 * unchanged, so the translated document keeps the exact source structure.
 */
export function preparePortableText(blocks: unknown): {
	clone: unknown[];
	spans: PortableTextSpanLike[];
} {
	if (!Array.isArray(blocks)) return { clone: [], spans: [] };
	const clone = structuredClone(blocks) as PortableTextBlockLike[];
	const spans: PortableTextSpanLike[] = [];
	for (const block of clone) {
		if (block?._type !== "block" || !Array.isArray(block.children)) continue;
		for (const child of block.children) {
			if (isTranslatableSpan(child)) spans.push(child);
		}
	}
	return { clone, spans };
}

/** FNV-1a hash, hex-encoded. Stable content fingerprint for the skip guard. */
export function hashSource(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/** Hard per-segment cap: longer segments are rejected as untranslatable. */
export const MAX_INPUT_CHARS = 8_000;

/**
 * One segment per call, plain-text reply. Batched JSON-array replies proved
 * unenforceable on real model output (Gemma 4 splits newline-carrying
 * segments into extra array items), and a plain string has no cardinality
 * to get wrong.
 */
export const SYSTEM_PROMPT = [
	"You are a professional Japanese-to-English translator for a technical blog.",
	"Translate the user's message from Japanese into natural, concise English.",
	"Keep code identifiers, product names, URLs, inline formatting, and untranslatable text unchanged.",
	"Reply with ONLY the translated text — no quotes around it, no commentary, no code fences.",
].join(" ");

/**
 * Normalize one model reply: unwrap a stray code fence, reject empties, and
 * transplant the source's edge whitespace (Portable Text soft breaks live in
 * span-trailing newlines the model tends to eat).
 */
export function cleanTranslatedSegment(source: string, raw: string): string {
	let text = raw.trim();
	const fenced = text.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
	if (fenced) text = fenced[1].trim();
	if (text === "") throw new Error("Model reply is empty");
	const lead = source.match(/^\s*/)?.[0] ?? "";
	const trail = source.match(/\s*$/)?.[0] ?? "";
	return lead + text + trail;
}

/* ------------------------------------------------------------------ */
/* Workers AI response parsing                                         */
/* ------------------------------------------------------------------ */

export interface ProviderMetadata {
	shape: "legacy" | "chat" | "unknown";
	finishReason?: string;
	usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
	promptFeedback?: string;
	responseChars?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
	return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

export function readChoiceContent(value: unknown): unknown {
	const message = firstChoice(value)?.message;
	return isRecord(message) ? message.content : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

export function readProviderMetadata(result: Record<string, unknown>): ProviderMetadata {
	const choice = firstChoice(result.choices);
	const finishReason =
		typeof choice?.finish_reason === "string"
			? choice.finish_reason
			: typeof result.finish_reason === "string"
				? result.finish_reason
				: undefined;
	const usage = isRecord(result.usage) ? result.usage : undefined;
	const response =
		typeof result.response === "string" ? result.response : readChoiceContent(result.choices);
	const promptFeedback = result.prompt_feedback;
	return {
		shape:
			typeof result.response === "string"
				? "legacy"
				: Array.isArray(result.choices)
					? "chat"
					: "unknown",
		finishReason,
		usage: usage
			? {
					promptTokens:
						optionalNumber(usage, "prompt_tokens") ?? optionalNumber(usage, "promptTokens"),
					completionTokens:
						optionalNumber(usage, "completion_tokens") ??
						optionalNumber(usage, "completionTokens"),
					totalTokens:
						optionalNumber(usage, "total_tokens") ?? optionalNumber(usage, "totalTokens"),
				}
			: undefined,
		promptFeedback:
			promptFeedback === undefined
				? undefined
				: JSON.stringify(promptFeedback).slice(0, 300),
		responseChars: typeof response === "string" ? response.length : undefined,
	};
}

/* ------------------------------------------------------------------ */
/* Plugin <-> Workflow job contract                                    */
/*                                                                     */
/* The afterSave/afterPublish hook only enqueues a TranslatorWorkflow  */
/* instance; the workflow calls back into these two plugin routes to   */
/* read the translation plan and to persist the result. Both sides     */
/* import this module so the contract cannot drift.                    */
/* ------------------------------------------------------------------ */

/** Workflow instance params. IDs and proof-of-origin only — never content. */
export interface TranslationJobParams {
	collection: string;
	id: string;
	/** Fingerprint of the source fields the job was enqueued for. */
	sourceHash: string;
	/** Token of the KV in-flight lease this job owns. */
	leaseToken: string;
	/** Shared secret minted by the plugin; authenticates route callbacks. */
	secret: string;
}

export type PlanResponse =
	| { ok: true; batch: string[]; model: string; gatewayId: string }
	| { ok: false; unauthorized?: boolean; reason?: string };

export interface CompleteRequest extends TranslationJobParams {
	/** Present on success: one translation per plan batch entry. */
	translations?: string[];
	providerRuns?: ProviderMetadata[];
	/** Present when the workflow gave up; triggers the stale-target clear. */
	error?: string;
}

export interface CompleteResponse {
	ok: boolean;
	unauthorized?: boolean;
	reason?: string;
}

/** Route paths the workflow calls on the SELF service binding. */
export const TRANSLATOR_API = {
	plan: "/_emdash/api/plugins/auto-translator/plan",
	complete: "/_emdash/api/plugins/auto-translator/complete",
} as const;
