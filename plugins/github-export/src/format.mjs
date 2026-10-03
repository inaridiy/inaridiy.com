/**
 * The canonical content/<collection>/*.md file format, shared by BOTH
 * sync paths:
 *   - this plugin (event-driven CMS -> git export)
 *   - scripts/content-sync.mjs (git -> CMS push, manual pull)
 *
 * Plain .mjs so Node can import it directly without a TS toolchain.
 * Keep serialize/parse in lockstep — files must round-trip byte-identically
 * or every sync pass would produce phantom diffs.
 */

/**
 * Synced collections. `fields` are frontmatter fields (in order); `body`
 * names the Portable Text field stored as the Markdown body (null =
 * frontmatter-only files, e.g. activities). `*_en` fields belong to the
 * translator and are never synced.
 */
export const COLLECTIONS = {
	posts: { dir: "content/posts", fields: ["title", "excerpt"], body: "content" },
	pages: { dir: "content/pages", fields: ["title"], body: "content" },
	activities: {
		dir: "content/activities",
		fields: ["title", "date", "kind", "url", "description"],
		body: null,
	},
};

/**
 * @param {{ cmsId?: string, slug: string, status: string, fields: Record<string, string>, body: string }} entry
 * @param {string[]} fieldOrder
 * @returns {string}
 */
export function serializeEntry(entry, fieldOrder) {
	const lines = ["---"];
	if (entry.cmsId) lines.push(`cms_id: ${JSON.stringify(entry.cmsId)}`);
	lines.push(`slug: ${JSON.stringify(entry.slug)}`);
	lines.push(`status: ${JSON.stringify(entry.status)}`);
	for (const field of fieldOrder) {
		if (entry.fields[field]) lines.push(`${field}: ${JSON.stringify(entry.fields[field])}`);
	}
	lines.push("---", "", (entry.body ?? "").trimEnd(), "");
	return lines.join("\n");
}

/**
 * @param {string} text
 * @param {string} fallbackSlug
 * @returns {{ cmsId?: string, slug: string, status: string, fields: Record<string, string>, body: string }}
 */
export function parseEntry(text, fallbackSlug) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
	const fields = {};
	let cmsId;
	let slug = fallbackSlug;
	let status = "published";
	let body = text;
	if (match) {
		body = text.slice(match[0].length);
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const rawValue = line.slice(idx + 1).trim();
			let value = rawValue;
			if (rawValue.startsWith('"')) {
				try {
					value = JSON.parse(rawValue);
				} catch {
					/* keep raw */
				}
			}
			if (key === "cms_id" && typeof value === "string" && value) cmsId = value;
			else if (key === "slug" && typeof value === "string") slug = value;
			else if (key === "status") status = value;
			else fields[key] = value;
		}
	}
	return { cmsId, slug, status, fields, body: body.trim() };
}
