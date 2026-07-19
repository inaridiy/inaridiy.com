/**
 * Pure translation helpers: Portable Text traversal, source hashing, and
 * model-reply parsing. No EmDash imports so this stays testable and
 * sandbox-safe (Web APIs only).
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

export const SYSTEM_PROMPT = [
	"You are a professional Japanese-to-English translator for a technical blog.",
	"The user sends a JSON array of Japanese strings.",
	"Translate each string into natural, concise English.",
	"Keep code identifiers, product names, URLs, and inline formatting untouched.",
	"Reply with ONLY a JSON array of the translated strings — same length, same order, no commentary, no code fences.",
].join(" ");

/** Split a batch into chunks so a single model call never needs an
 * excessively long output (long posts overflow max output tokens). */
export function chunkBatch<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/** Extract a JSON array from an LLM reply, tolerating code fences and prose. */
export function parseTranslatedArray(raw: string, expectedLength: number): string[] {
	let text = raw.trim();
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) text = fenced[1].trim();
	if (!text.startsWith("[")) {
		const start = text.indexOf("[");
		const end = text.lastIndexOf("]");
		if (start === -1 || end === -1 || end < start) {
			throw new Error("Model reply contains no JSON array");
		}
		text = text.slice(start, end + 1);
	}
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Model reply is not a JSON array");
	if (parsed.length !== expectedLength) {
		throw new Error(
			`Model returned ${parsed.length} items, expected ${expectedLength}`,
		);
	}
	return parsed.map((item) => String(item ?? ""));
}
