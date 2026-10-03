/**
 * Two-way sync between content/<collection>/*.md and the EmDash CMS.
 * Covers posts, pages, and activities (see COLLECTIONS in the shared
 * format module).
 *
 *   node scripts/content-sync.mjs pull            CMS -> local Markdown files
 *   node scripts/content-sync.mjs push            local Markdown files -> CMS
 *   node scripts/content-sync.mjs push --prune    ...and delete remote entries
 *                                                 that have no local file
 *
 * Markdown is the interchange format: EmDash stores Portable Text, and the
 * official client converts PT <-> Markdown on read/write (lossless for
 * standard blocks; unknown blocks survive as <!--ec:block ... --> fences).
 * Activities are frontmatter-only files (no rich-text body).
 *
 * Auth (in priority order):
 *   - EMDASH_TOKEN / EMDASH_REFRESH_TOKEN env vars (CI)
 *   - stored credentials from `emdash login` (~/.config/emdash/auth.json)
 *   - dev bypass when EMDASH_URL is localhost (default)
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
import { COLLECTIONS, parseEntry, serializeEntry } from "emdash-plugin-github-export/format";

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

async function fetchRemote(client, collection) {
	const items = [];
	let cursor;
	do {
		const page = await client.list(collection, { limit: 100, cursor });
		items.push(...page.items);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return items.filter((item) => item.slug);
}

/** Normalized comparable snapshot of one entry. */
function snapshot(entry, format) {
	return JSON.stringify({
		slug: entry.slug,
		status: entry.status,
		fields: format.fields.map((f) => entry.fields[f] ?? ""),
		body: entry.body.trim(),
	});
}

function remoteToEntry(item, format) {
	return {
		cmsId: item.id,
		slug: item.slug,
		status: item.status,
		fields: Object.fromEntries(
			format.fields.map((f) => [f, typeof item.data[f] === "string" ? item.data[f] : ""]),
		),
		body:
			format.body && typeof item.data[format.body] === "string" ? item.data[format.body] : "",
	};
}

function entryToData(entry, format) {
	const data = { ...entry.fields };
	if (format.body) data[format.body] = entry.body;
	return data;
}

async function pull() {
	const client = createClient();
	for (const [collection, format] of Object.entries(COLLECTIONS)) {
		await mkdir(format.dir, { recursive: true });
		const remote = await fetchRemote(client, collection);
		const keep = new Set();

		for (const listed of remote) {
			// get() converts Portable Text fields to Markdown
			const item = await client.get(collection, listed.id);
			const entry = remoteToEntry({ ...item, slug: listed.slug }, format);
			const file = `${listed.slug}.md`;
			keep.add(file);
			await writeFile(join(format.dir, file), serializeEntry(entry, format.fields), "utf8");
			console.log(`pulled  ${format.dir}/${file}`);
		}

		for (const file of await readdir(format.dir)) {
			if (file.endsWith(".md") && !keep.has(file)) {
				await unlink(join(format.dir, file));
				console.log(`removed ${format.dir}/${file} (no longer on the CMS)`);
			}
		}
	}
	console.log("done");
}

async function push({ prune = false } = {}) {
	const client = createClient();
	for (const [collection, format] of Object.entries(COLLECTIONS)) {
		await mkdir(format.dir, { recursive: true });
		const files = (await readdir(format.dir)).filter((f) => f.endsWith(".md"));
		const remote = await fetchRemote(client, collection);
		const remoteBySlug = new Map(remote.map((item) => [item.slug, item]));
		const remoteById = new Map(remote.map((item) => [item.id, item]));
		const matchedRemoteIds = new Set();
		const localCmsIds = new Set();

		for (const file of files) {
			const text = await readFile(join(format.dir, file), "utf8");
			const fileSlug = file.replace(/\.md$/, "");
			const entry = parseEntry(text, fileSlug);
			if (entry.slug !== fileSlug) {
				throw new Error(
					`${format.dir}/${file}: filename and frontmatter slug must match (${fileSlug} != ${entry.slug})`,
				);
			}
			if (entry.cmsId && localCmsIds.has(entry.cmsId)) {
				throw new Error(`${format.dir}/${file}: duplicate cms_id ${entry.cmsId}`);
			}
			if (entry.cmsId) localCmsIds.add(entry.cmsId);
			const data = entryToData(entry, format);
			const existing = entry.cmsId
				? remoteById.get(entry.cmsId)
				: remoteBySlug.get(entry.slug);
			if (entry.cmsId && !existing) {
				throw new Error(
					`${format.dir}/${file}: cms_id ${entry.cmsId} does not exist in ${collection}; refusing slug fallback`,
				);
			}

			if (!existing) {
				// Status is a lifecycle transition, not an update field: create as
				// draft, then publish (same flow as the official CLI).
				const created = await client.create(collection, { slug: entry.slug, data });
				if (entry.status === "published") await client.publish(collection, created.id);
				await writeFile(
					join(format.dir, file),
					serializeEntry({ ...entry, cmsId: created.id }, format.fields),
					"utf8",
				);
				matchedRemoteIds.add(created.id);
				console.log(`created ${collection}/${entry.slug}`);
				continue;
			}
			matchedRemoteIds.add(existing.id);
			if (!entry.cmsId) {
				console.warn(
					`migrate ${format.dir}/${file}: matched legacy slug and wrote cms_id ${existing.id}`,
				);
				entry.cmsId = existing.id;
				await writeFile(join(format.dir, file), serializeEntry(entry, format.fields), "utf8");
			}

			// Re-read for the _rev token + Markdown-converted comparison
			const current = await client.get(collection, existing.id);
			const unchanged =
				snapshot(remoteToEntry(current, format), format) ===
				snapshot(entry, format);
			if (unchanged) {
				console.log(`skip    ${collection}/${entry.slug} (unchanged)`);
				continue;
			}
			await client.update(collection, existing.id, {
				data,
				slug: entry.slug,
				_rev: current._rev,
			});
			if (entry.status === "published") {
				await client.publish(collection, existing.id);
			} else if (entry.status === "draft" && current.status === "published") {
				await client.unpublish(collection, existing.id);
			}
			console.log(`updated ${collection}/${entry.slug}`);
		}

		for (const item of remote) {
			if (matchedRemoteIds.has(item.id)) continue;
			if (prune) {
				await client.delete(collection, item.id);
				console.log(`deleted ${collection}/${item.slug} (pruned)`);
			} else {
				console.log(
					`notice  ${collection}/${item.slug} exists on the CMS but not locally (use --prune to delete)`,
				);
			}
		}
	}
	console.log("done");
}

const mode = process.argv[2];
const prune = process.argv.includes("--prune");
if (mode === "pull") await pull();
else if (mode === "push") await push({ prune });
else {
	console.error("usage: node scripts/content-sync.mjs <pull|push> [--prune]");
	process.exit(1);
}
