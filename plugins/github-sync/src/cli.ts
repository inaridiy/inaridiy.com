/**
 * emdash-github-sync — the git -> CMS half of GitHub Sync.
 *
 *   emdash-github-sync push            Markdown files -> CMS (create / update / publish)
 *   emdash-github-sync push --prune    ...and trash CMS entries that have no file
 *   emdash-github-sync pull            CMS -> Markdown files (first import / recovery)
 *
 * Options: --dir <folder> (default "content"), --collections a,b,
 *          --include-drafts (pull only).
 * Auth:    EMDASH_URL plus EMDASH_TOKEN (an API token from the admin), or a
 *          stored `emdash login` session, or dev bypass on localhost.
 *
 * Files use the plugin's format (./format.mjs). New files get their `cms_id`
 * written back, so commit the folder after a push.
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EmDashClient } from "emdash/client";
import {
	collectionFormat,
	isSyncedEntry,
	parseEntry,
	serializeEntry,
	type CollectionFormat,
	type MarkdownEntry,
} from "./format.mjs";

type Client = InstanceType<typeof EmDashClient>;
type RemoteItem = Awaited<ReturnType<Client["get"]>>;

interface Collection {
	slug: string;
	format: CollectionFormat;
	types: Map<string, string>;
}

const { positionals, values: flags } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: "string", default: "content" },
		collections: { type: "string" },
		prune: { type: "boolean", default: false },
		"include-drafts": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

function storedCredentials(baseUrl: string): { accessToken?: string; refreshToken?: string } | null {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".config", "emdash", "auth.json"), "utf8"));
		return auth[baseUrl] ?? null;
	} catch {
		return null;
	}
}

function createClient(): Client {
	const baseUrl = (process.env.EMDASH_URL || "http://localhost:4321").replace(/\/+$/, "");
	const stored = storedCredentials(baseUrl);
	const token = process.env.EMDASH_TOKEN || stored?.accessToken;
	const refreshToken = process.env.EMDASH_REFRESH_TOKEN || stored?.refreshToken;
	const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
	if (!token && !refreshToken && !isLocal) {
		throw new Error("Set EMDASH_TOKEN (an API token from the EmDash admin) or run `emdash login`.");
	}
	return new EmDashClient({ baseUrl, token, refreshToken, devBypass: !token && !refreshToken && isLocal });
}

async function loadCollections(client: Client): Promise<Collection[]> {
	const wanted = flags.collections?.split(",").map((name) => name.trim()).filter(Boolean);
	const all = await client.collections();
	const collections: Collection[] = [];
	for (const { slug } of all) {
		if (wanted && !wanted.includes(slug)) continue;
		const { fields } = await client.collection(slug);
		collections.push({
			slug,
			format: collectionFormat(fields),
			types: new Map(fields.map((field) => [field.slug, field.type])),
		});
	}
	return collections;
}

async function listSynced(client: Client, collection: string) {
	const items = [];
	for await (const item of client.listAll(collection)) {
		if (item.slug && isSyncedEntry(item)) items.push(item);
	}
	return items;
}

/** Frontmatter values are untyped; coerce them to the schema's field type. */
function coerce(value: unknown, type: string | undefined): unknown {
	if (value === null || value === undefined) return value;
	switch (type) {
		case "number":
		case "integer":
			return typeof value === "number" ? value : Number(value);
		case "boolean":
			return value === true || value === "true";
		default:
			return typeof value === "string" ? value : String(value);
	}
}

function toFileEntry(item: RemoteItem, collection: Collection): MarkdownEntry {
	const { format } = collection;
	const fields: Record<string, unknown> = {};
	for (const field of format.fields) {
		const value = item.data[field];
		if (value !== null && value !== undefined && value !== "" && typeof value !== "object") {
			fields[field] = value;
		}
	}
	const body = format.body ? item.data[format.body] : "";
	return {
		cmsId: item.id,
		slug: item.slug ?? "",
		status: item.status,
		fields,
		body: typeof body === "string" ? body : "",
	};
}

function toData(entry: MarkdownEntry, collection: Collection): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const field of collection.format.fields) {
		if (field in entry.fields) data[field] = coerce(entry.fields[field], collection.types.get(field));
	}
	if (collection.format.body) data[collection.format.body] = entry.body;
	return data;
}

/** Normalised comparison, so an unchanged file never triggers an update. */
function snapshot(entry: MarkdownEntry, collection: Collection): string {
	return JSON.stringify({
		slug: entry.slug,
		status: entry.status,
		fields: collection.format.fields.map((field) =>
			field in entry.fields ? coerce(entry.fields[field], collection.types.get(field)) : null,
		),
		body: entry.body.trim(),
	});
}

async function pull(client: Client) {
	for (const collection of await loadCollections(client)) {
		const dir = join(flags.dir!, collection.slug);
		const keep = new Set<string>();
		for (const listed of await listSynced(client, collection.slug)) {
			if (listed.status !== "published" && !flags["include-drafts"]) continue;
			// get() returns Portable Text fields converted to Markdown
			const item = await client.get(collection.slug, listed.id);
			const file = `${listed.slug}.md`;
			keep.add(file);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, file), serializeEntry(toFileEntry(item, collection), collection.format));
			console.log(`pulled  ${dir}/${file}`);
		}
		const existing = await readdir(dir).catch(() => [] as string[]);
		for (const file of existing) {
			if (file.endsWith(".md") && !keep.has(file)) {
				await unlink(join(dir, file));
				console.log(`removed ${dir}/${file} (not on the CMS)`);
			}
		}
	}
}

async function push(client: Client) {
	for (const collection of await loadCollections(client)) {
		const dir = join(flags.dir!, collection.slug);
		const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".md"));
		const remote = await listSynced(client, collection.slug);
		const remoteById = new Map(remote.map((item) => [item.id, item]));
		const remoteBySlug = new Map(remote.map((item) => [item.slug, item]));
		const matched = new Set<string>();
		const seenIds = new Set<string>();

		for (const file of files) {
			const path = join(dir, file);
			const fileSlug = file.replace(/\.md$/, "");
			const entry = parseEntry(await readFile(path, "utf8"), fileSlug);
			if (entry.slug !== fileSlug) {
				throw new Error(`${path}: file name and slug must match (${fileSlug} != ${entry.slug})`);
			}
			if (entry.cmsId) {
				if (seenIds.has(entry.cmsId)) throw new Error(`${path}: duplicate cms_id ${entry.cmsId}`);
				seenIds.add(entry.cmsId);
			}
			const existing = entry.cmsId ? remoteById.get(entry.cmsId) : remoteBySlug.get(entry.slug);
			if (entry.cmsId && !existing) {
				throw new Error(`${path}: cms_id ${entry.cmsId} is not in ${collection.slug}; refusing to guess by slug`);
			}

			if (!existing) {
				// Status is a lifecycle transition: create as draft, then publish.
				const created = await client.create(collection.slug, {
					slug: entry.slug,
					data: toData(entry, collection),
				});
				if (entry.status === "published") await client.publish(collection.slug, created.id);
				await writeFile(path, serializeEntry({ ...entry, cmsId: created.id }, collection.format));
				matched.add(created.id);
				console.log(`created ${collection.slug}/${entry.slug}`);
				continue;
			}
			matched.add(existing.id);
			if (!entry.cmsId) {
				entry.cmsId = existing.id;
				await writeFile(path, serializeEntry(entry, collection.format));
				console.log(`linked  ${path} -> ${existing.id}`);
			}

			const current = await client.get(collection.slug, existing.id);
			if (snapshot(toFileEntry(current, collection), collection) === snapshot(entry, collection)) {
				continue;
			}
			await client.update(collection.slug, existing.id, {
				data: toData(entry, collection),
				slug: entry.slug,
				_rev: current._rev,
			});
			if (entry.status === "published") await client.publish(collection.slug, existing.id);
			else if (current.status === "published") await client.unpublish(collection.slug, existing.id);
			console.log(`updated ${collection.slug}/${entry.slug}`);
		}

		for (const item of remote) {
			if (matched.has(item.id)) continue;
			if (flags.prune) {
				await client.delete(collection.slug, item.id);
				console.log(`trashed ${collection.slug}/${item.slug} (no file)`);
			}
		}
	}
}

const USAGE = "usage: emdash-github-sync <push|pull> [--dir content] [--collections a,b] [--prune] [--include-drafts]";

const command = positionals[0];
if (flags.help || (command !== "push" && command !== "pull")) {
	console.log(USAGE);
	process.exit(flags.help ? 0 : 1);
}
try {
	const client = createClient();
	await (command === "push" ? push(client) : pull(client));
	console.log("done");
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
