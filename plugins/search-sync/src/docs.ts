/**
 * Shared document-building helpers for the AI Search integration.
 *
 * Used from two places with the SAME keys/metadata/hash scheme, so both
 * paths stay interchangeable:
 *  - the search-sync plugin (event-driven upsert on publish/save)
 *  - src/search-index.ts (hourly cron reconciliation over D1 rows)
 */

export interface SearchDoc {
	/** AI Search item key, mirrors the site URL (e.g. "posts/slug.md") */
	key: string;
	title: string;
	url: string;
	lang: "ja" | "en";
	body: string;
	collection: string;
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

function str(fields: Record<string, unknown>, key: string): string {
	const value = fields[key];
	return typeof value === "string" ? value : "";
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
	if (!slug) return [];

	if (collection === "posts") {
		const docs: SearchDoc[] = [
			{
				key: `posts/${slug}.md`,
				collection,
				title: str(fields, "title"),
				url: `/posts/${slug}`,
				lang: "ja",
				body: [str(fields, "excerpt"), portableTextToMarkdown(fields.content)]
					.filter(Boolean)
					.join("\n\n"),
			},
		];
		if (str(fields, "title_en") || fields.content_en) {
			docs.push({
				key: `posts/${slug}.en.md`,
				collection,
				title: str(fields, "title_en") || str(fields, "title"),
				url: `/en/posts/${slug}`,
				lang: "en",
				body: [str(fields, "excerpt_en"), portableTextToMarkdown(fields.content_en)]
					.filter(Boolean)
					.join("\n\n"),
			});
		}
		return docs;
	}

	if (collection === "pages") {
		return [
			{
				key: `pages/${slug}.md`,
				collection,
				title: str(fields, "title"),
				url: slug === "about" ? "/about" : `/pages/${slug}`,
				lang: "ja",
				body: portableTextToMarkdown(fields.content),
			},
		];
	}

	if (collection === "activities") {
		const date = fields.date instanceof Date ? fields.date.toISOString() : str(fields, "date");
		return [
			{
				key: `activities/${slug}.md`,
				collection,
				title: str(fields, "title"),
				url: "/activities",
				lang: "ja",
				body: [
					date && `Date: ${date}`,
					str(fields, "kind") && `Kind: ${str(fields, "kind")}`,
					str(fields, "url") && `Link: ${str(fields, "url")}`,
					str(fields, "description"),
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		];
	}

	return [];
}

/** Collections the search index covers. */
export const INDEXED_COLLECTIONS = ["posts", "pages", "activities"] as const;
