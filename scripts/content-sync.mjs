/**
 * Two-way sync between content/posts/*.md and the EmDash CMS.
 *
 *   node scripts/content-sync.mjs pull            CMS -> local Markdown files
 *   node scripts/content-sync.mjs push            local Markdown files -> CMS
 *   node scripts/content-sync.mjs push --prune    ...and delete remote posts
 *                                                 that have no local file
 *
 * Markdown is the interchange format: EmDash stores Portable Text, and the
 * official client converts PT <-> Markdown on read/write (lossless for
 * standard blocks; unknown blocks survive as <!--ec:block ... --> fences).
 *
 * Auth (in priority order):
 *   - EMDASH_TOKEN          access token
 *   - EMDASH_REFRESH_TOKEN  90-day refresh token (recommended for CI; the
 *                           client auto-refreshes access tokens with it)
 *   - dev bypass            when EMDASH_URL is localhost (default)
 *
 * The translator plugin owns the *_en fields — they are never synced here.
 * Taxonomies (category/tag) are managed in the admin, not in frontmatter.
 */
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EmDashClient } from "emdash/client";
// Canonical file format — shared with the github-export plugin so the
// event-driven CMS->git commits and this script produce identical bytes.
import {
	FRONT_FIELDS,
	parseEntry,
	serializeEntry,
} from "emdash-plugin-github-export/format";

const CONTENT_DIR = "content/posts";
const COLLECTION = "posts";

/** Stored credentials from `emdash login` (~/.config/emdash/auth.json). */
function storedCredentials(baseUrl) {
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".config", "emdash", "auth.json"), "utf8"),
		);
		return auth[baseUrl] ?? null;
	} catch {
		return null;
	}
}

function createClient() {
	const baseUrl = process.env.EMDASH_URL || "http://localhost:4321";
	let token = process.env.EMDASH_TOKEN || "";
	let refreshToken = process.env.EMDASH_REFRESH_TOKEN || "";
	if (!token && !refreshToken) {
		const cred = storedCredentials(baseUrl);
		if (cred) {
			token = cred.accessToken ?? "";
			refreshToken = cred.refreshToken ?? "";
		}
	}
	const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
	return new EmDashClient({
		baseUrl,
		token: token || undefined,
		refreshToken: refreshToken || undefined,
		devBypass: !token && !refreshToken && isLocal,
	});
}

async function fetchRemotePosts(client) {
	const posts = [];
	let cursor;
	do {
		const page = await client.list(COLLECTION, { limit: 100, cursor });
		posts.push(...page.items);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return posts.filter((post) => post.slug);
}

/** Normalized comparable snapshot of one post. */
function snapshot(entry) {
	return JSON.stringify({
		status: entry.status,
		fields: FRONT_FIELDS.map((f) => entry.fields[f] ?? ""),
		body: entry.body.trim(),
	});
}

function remoteToEntry(item) {
	return {
		slug: item.slug,
		status: item.status,
		fields: Object.fromEntries(
			FRONT_FIELDS.map((f) => [f, typeof item.data[f] === "string" ? item.data[f] : ""]),
		),
		body: typeof item.data.content === "string" ? item.data.content : "",
	};
}

async function pull() {
	const client = createClient();
	await mkdir(CONTENT_DIR, { recursive: true });
	const remote = await fetchRemotePosts(client);
	const keep = new Set();

	for (const listed of remote) {
		// get() converts Portable Text fields to Markdown
		const item = await client.get(COLLECTION, listed.id);
		const entry = remoteToEntry({ ...item, slug: listed.slug });
		const file = `${listed.slug}.md`;
		keep.add(file);
		await writeFile(join(CONTENT_DIR, file), serializeEntry(entry), "utf8");
		console.log(`pulled  ${file}`);
	}

	for (const file of await readdir(CONTENT_DIR)) {
		if (file.endsWith(".md") && !keep.has(file)) {
			await unlink(join(CONTENT_DIR, file));
			console.log(`removed ${file} (no longer on the CMS)`);
		}
	}
	console.log(`done: ${remote.length} post(s)`);
}

async function push({ prune = false } = {}) {
	const client = createClient();
	await mkdir(CONTENT_DIR, { recursive: true });
	const files = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith(".md"));
	const remote = await fetchRemotePosts(client);
	const remoteBySlug = new Map(remote.map((item) => [item.slug, item]));
	const localSlugs = new Set();

	for (const file of files) {
		const text = await readFile(join(CONTENT_DIR, file), "utf8");
		const entry = parseEntry(text, file.replace(/\.md$/, ""));
		localSlugs.add(entry.slug);
		const data = { ...entry.fields, content: entry.body };
		const existing = remoteBySlug.get(entry.slug);

		if (!existing) {
			// Status is a lifecycle transition, not an update field: create as
			// draft, then publish (same flow as the official CLI).
			const created = await client.create(COLLECTION, { slug: entry.slug, data });
			if (entry.status === "published") await client.publish(COLLECTION, created.id);
			console.log(`created ${entry.slug}`);
			continue;
		}

		// Re-read for the _rev token + Markdown-converted comparison
		const current = await client.get(COLLECTION, existing.id);
		const unchanged =
			snapshot(remoteToEntry({ ...current, slug: entry.slug })) === snapshot(entry);
		if (unchanged) {
			console.log(`skip    ${entry.slug} (unchanged)`);
			continue;
		}
		await client.update(COLLECTION, existing.id, { data, _rev: current._rev });
		if (entry.status === "published") {
			await client.publish(COLLECTION, existing.id);
		} else if (entry.status === "draft" && current.status === "published") {
			await client.unpublish(COLLECTION, existing.id);
		}
		console.log(`updated ${entry.slug}`);
	}

	for (const item of remote) {
		if (localSlugs.has(item.slug)) continue;
		if (prune) {
			await client.delete(COLLECTION, item.id);
			console.log(`deleted ${item.slug} (pruned)`);
		} else {
			console.log(`notice  ${item.slug} exists on the CMS but not locally (use --prune to delete)`);
		}
	}
	console.log(`done: ${files.length} file(s)`);
}

const mode = process.argv[2];
const prune = process.argv.includes("--prune");
if (mode === "pull") await pull();
else if (mode === "push") await push({ prune });
else {
	console.error("usage: node scripts/content-sync.mjs <pull|push> [--prune]");
	process.exit(1);
}
