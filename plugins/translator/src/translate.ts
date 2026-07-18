/**
 * Pure translation helpers: Portable Text traversal, source hashing, and the
 * AI Gateway chat-completions call. No EmDash imports so this stays testable
 * and sandbox-safe (Web APIs only).
 */

export interface GatewayConfig {
	accountId: string;
	gatewayId: string;
	/** `{provider}/{model}` for the AI Gateway unified endpoint, e.g.
	 * "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" or "openai/gpt-4o-mini". */
	model: string;
	/** cf-aig-authorization token for authenticated gateways (optional). */
	apiToken?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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

const SYSTEM_PROMPT = [
	"You are a professional Japanese-to-English translator for a technical blog.",
	"The user sends a JSON array of Japanese strings.",
	"Translate each string into natural, concise English.",
	"Keep code identifiers, product names, URLs, and inline formatting untouched.",
	"Reply with ONLY a JSON array of the translated strings — same length, same order, no commentary, no code fences.",
].join(" ");

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

/**
 * Translate a batch of Japanese strings via the AI Gateway unified
 * (OpenAI-compatible) endpoint. Model switching = changing `config.model`;
 * provider keys live in the gateway's BYOK store, not here.
 */
export async function translateBatch(
	texts: string[],
	config: GatewayConfig,
	fetchFn: FetchLike,
): Promise<string[]> {
	if (texts.length === 0) return [];
	const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat/chat/completions`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (config.apiToken) {
		headers["cf-aig-authorization"] = `Bearer ${config.apiToken}`;
	}
	const response = await fetchFn(url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: config.model,
			temperature: 0.2,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: JSON.stringify(texts) },
			],
		}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`AI Gateway request failed: ${response.status} ${body.slice(0, 300)}`,
		);
	}
	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error("AI Gateway reply has no message content");
	}
	return parseTranslatedArray(content, texts.length);
}
