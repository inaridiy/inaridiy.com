/**
 * The Markdown file format shared by both directions:
 *   - the plugin (CMS -> git, on every content change)
 *   - the CLI (git -> CMS push, and pull for the first import)
 *
 * One file per entry at `<dir>/<collection>/<slug>.md`:
 *
 *   ---
 *   cms_id: "01J..."          stable identity (survives slug renames)
 *   slug: "hello-world"
 *   status: "published"
 *   title: "Hello"            scalar fields, in schema order, JSON-encoded
 *   ---
 *
 *   Body = the collection's first Portable Text field, as Markdown.
 *
 * Plain .mjs so the Node CLI and the sandbox bundle import the same code.
 * serialize/parse must round-trip byte-identically, or every sync pass would
 * produce phantom diffs.
 */

/** Field types stored as frontmatter values. Everything else is left untouched. */
const SCALAR_TYPES = new Set([
	"string",
	"text",
	"slug",
	"url",
	"email",
	"number",
	"integer",
	"boolean",
	"datetime",
	"date",
	"select",
]);

const RESERVED_KEYS = new Set(["cms_id", "slug", "status"]);

/**
 * @typedef {{ slug: string, type: string, sortOrder?: number }} FieldLike
 * @typedef {{ fields: string[], body: string | null }} CollectionFormat
 * @typedef {{ cmsId?: string, slug: string, status: string, fields: Record<string, unknown>, body: string }} Entry
 */

/**
 * Derive a collection's file format from its schema: scalar fields become
 * frontmatter (schema order), the first Portable Text field becomes the body.
 * @param {FieldLike[]} fields
 * @returns {CollectionFormat}
 */
export function collectionFormat(fields) {
	const ordered = [...fields].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	const body = ordered.find((field) => field.type === "portableText")?.slug ?? null;
	return {
		fields: ordered
			.filter((field) => SCALAR_TYPES.has(field.type) && !RESERVED_KEYS.has(field.slug))
			.map((field) => field.slug),
		body,
	};
}

/**
 * The entry a file represents: the original of each translation group.
 * Translations live in the same group under other locales and are not synced.
 * @param {{ id: string, translationGroup?: string | null }} item
 */
export function isSyncedEntry(item) {
	return !item.translationGroup || item.translationGroup === item.id;
}

/**
 * @param {string} dir
 * @param {string} collection
 * @param {string} slug
 */
export function entryPath(dir, collection, slug) {
	const root = dir.replace(/^\/+|\/+$/g, "");
	return `${root ? `${root}/` : ""}${collection}/${slug}.md`;
}

function isEmpty(value) {
	return value === undefined || value === null || value === "";
}

/**
 * @param {Entry} entry
 * @param {CollectionFormat} format
 * @returns {string}
 */
export function serializeEntry(entry, format) {
	const lines = ["---"];
	if (entry.cmsId) lines.push(`cms_id: ${JSON.stringify(entry.cmsId)}`);
	lines.push(`slug: ${JSON.stringify(entry.slug)}`);
	lines.push(`status: ${JSON.stringify(entry.status)}`);
	for (const field of format.fields) {
		const value = entry.fields[field];
		if (!isEmpty(value)) lines.push(`${field}: ${JSON.stringify(value)}`);
	}
	lines.push("---", "", (entry.body ?? "").trimEnd(), "");
	return lines.join("\n");
}

/**
 * Lenient parser: values are JSON when they parse as JSON, raw text
 * otherwise, so hand-written `title: Hello` works as well as `title: "Hello"`.
 * @param {string} text
 * @param {string} fallbackSlug
 * @returns {Entry}
 */
export function parseEntry(text, fallbackSlug) {
	const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?/);
	/** @type {Record<string, unknown>} */
	const fields = {};
	let cmsId;
	let slug = fallbackSlug;
	let status = "published";
	let body = text;
	if (match) {
		body = text.replace(/\r\n/g, "\n").slice(match[0].length);
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const raw = line.slice(idx + 1).trim();
			let value = raw;
			try {
				value = JSON.parse(raw);
			} catch {
				/* keep raw text */
			}
			if (key === "cms_id" && typeof value === "string" && value) cmsId = value;
			else if (key === "slug" && typeof value === "string" && value) slug = value;
			else if (key === "status" && typeof value === "string") status = value;
			else if (key) fields[key] = value;
		}
	}
	return { cmsId, slug, status, fields, body: body.trim() };
}

/**
 * Entry data -> file entry fields (only the format's scalar fields).
 * @param {Record<string, unknown>} data
 * @param {CollectionFormat} format
 */
export function pickFields(data, format) {
	/** @type {Record<string, unknown>} */
	const fields = {};
	for (const field of format.fields) {
		const value = data[field];
		if (!isEmpty(value) && typeof value !== "object") fields[field] = value;
	}
	return fields;
}
