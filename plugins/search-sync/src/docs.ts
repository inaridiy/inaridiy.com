/**
 * Shared document-building helpers for the AI Search integration.
 *
 * Used from two places with the SAME keys/metadata/hash scheme, so both
 * paths stay interchangeable:
 *  - the search-sync plugin (event-driven upsert on publish/save)
 *  - src/search-index.ts (hourly cron reconciliation over D1 rows)
 */
import {
	CONTENT_COLLECTIONS,
	getContentContract,
	isContentCollection,
	type ContentCollection,
	type SearchBodyField,
} from "@inaridiy/content-contract";

export interface SearchDoc {
	/** AI Search item key, mirrors the site URL (e.g. "posts/slug.md") */
	key: string;
	title: string;
	url: string;
	lang: "ja" | "en";
	body: string;
	collection: ContentCollection;
}

interface PortableTextSpanLike {
	_type?: string;
	text?: unknown;
}

interface PortableTextBlockLike {
	_type?: string;
	style?: string;
	listItem?: string;
	code?: unknown;
	children?: PortableTextSpanLike[];
}

const HEADING_LEVELS: Record<string, string> = {
	h1: "#",
	h2: "##",
	h3: "###",
	h4: "####",
	h5: "#####",
	h6: "######",
};

/** Convert stored Portable Text (JSON string or parsed array) to Markdown. */
export function portableTextToMarkdown(value: unknown): string {
	let blocks: unknown = value;
	if (typeof value === "string") {
		try {
			blocks = JSON.parse(value);
		} catch {
			return value;
		}
	}
	if (!Array.isArray(blocks)) return "";

	const lines: string[] = [];
	for (const raw of blocks as PortableTextBlockLike[]) {
		if (!raw || typeof raw !== "object") continue;
		if (raw._type === "code" && typeof raw.code === "string") {
			lines.push("```\n" + raw.code + "\n```");
			continue;
		}
		if (raw._type !== "block" || !Array.isArray(raw.children)) continue;
		const text = raw.children
			.filter((c) => c._type === "span" && typeof c.text === "string")
			.map((c) => c.text)
			.join("");
		if (text.trim() === "") continue;
		const heading = raw.style ? HEADING_LEVELS[raw.style] : undefined;
		if (heading) lines.push(`${heading} ${text}`);
		else if (raw.style === "blockquote") lines.push(`> ${text}`);
		else if (raw.listItem) lines.push(`- ${text}`);
		else lines.push(text);
	}
	return lines.join("\n\n");
}

/** FNV-1a hash, hex-encoded. Stable fingerprint for skip-if-unchanged. */
export function hashContent(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/** The Markdown payload uploaded as the AI Search item body. */
export function renderDoc(doc: SearchDoc): string {
	return [`# ${doc.title}`, "", `URL: ${doc.url}`, "", doc.body, ""].join("\n");
}

/** Item metadata; `url`/`title`/`lang` drive /search result links,
 * `hash` drives skip-if-unchanged, `entryId` drives delete-by-entry. */
export function docMetadata(
	doc: SearchDoc,
	hash: string,
	entryId: string,
): Record<string, unknown> {
	return {
		hash,
		url: doc.url,
		title: doc.title,
		lang: doc.lang,
		collection: doc.collection,
		entryId,
	};
}

function hasValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (value instanceof Date) return !Number.isNaN(value.getTime());
	return value !== null && value !== undefined;
}

function textValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function projectedValue(fields: Record<string, unknown>, spec: SearchBodyField): unknown {
	const value = fields[spec.field];
	if (hasValue(value) || !spec.fallbackField) return value;
	return fields[spec.fallbackField];
}

/**
 * Build the search documents for one content entry. `fields` accepts both
 * parsed values (plugin path, from ctx.content.get) and raw D1 row values
 * (cron path) — Portable Text may be an array or a JSON string.
 */
export function buildEntryDocs(
	collection: string,
	slug: string,
	fields: Record<string, unknown>,
): SearchDoc[] {
	if (!slug || !isContentCollection(collection)) return [];
	const contract = getContentContract(collection);
	const docs: SearchDoc[] = [];

	for (const projection of contract.search) {
		if (
			projection.availabilityFields?.length &&
			!projection.availabilityFields.some((field) => hasValue(fields[field]))
		) {
			continue;
		}

		const title =
			textValue(fields[projection.titleField]) ||
			(projection.titleFallbackField
				? textValue(fields[projection.titleFallbackField])
				: "");
		const body = projection.body
			.map((spec) => {
				const value = projectedValue(fields, spec);
				const rendered =
					spec.kind === "portableText" ? portableTextToMarkdown(value) : textValue(value);
				if (!rendered) return "";
				return spec.label ? `${spec.label}: ${rendered}` : rendered;
			})
			.filter(Boolean)
			.join("\n\n");

		docs.push({
			key: `${collection}/${slug}${projection.keySuffix}.md`,
			collection,
			title,
			url: projection.url(slug),
			lang: projection.lang,
			body,
		});
	}

	return docs;
}

/** Collections the search index covers. */
export const INDEXED_COLLECTIONS = CONTENT_COLLECTIONS;
