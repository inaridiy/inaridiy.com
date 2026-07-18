/**
 * The canonical content/posts/*.md file format, shared by BOTH sync paths:
 *   - this plugin (event-driven CMS -> git export)
 *   - scripts/content-sync.mjs (git -> CMS push, manual pull)
 *
 * Plain .mjs so Node can import it directly without a TS toolchain.
 * Keep serialize/parse in lockstep — files must round-trip byte-identically
 * or every sync pass would produce phantom diffs.
 */

/** Fields that sync through frontmatter (everything else stays CMS-side). */
export const FRONT_FIELDS = ["title", "excerpt"];

/**
 * @param {{ slug: string, status: string, fields: Record<string, string>, body: string }} entry
 * @returns {string}
 */
export function serializeEntry(entry) {
	const lines = ["---"];
	lines.push(`slug: ${JSON.stringify(entry.slug)}`);
	lines.push(`status: ${JSON.stringify(entry.status)}`);
	for (const field of FRONT_FIELDS) {
		if (entry.fields[field]) lines.push(`${field}: ${JSON.stringify(entry.fields[field])}`);
	}
	lines.push("---", "", entry.body.trimEnd(), "");
	return lines.join("\n");
}

/**
 * @param {string} text
 * @param {string} fallbackSlug
 * @returns {{ slug: string, status: string, fields: Record<string, string>, body: string }}
 */
export function parseEntry(text, fallbackSlug) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
	const fields = {};
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
			if (key === "slug") slug = value;
			else if (key === "status") status = value;
			else fields[key] = value;
		}
	}
	return { slug, status, fields, body: body.trim() };
}
