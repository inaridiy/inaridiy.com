import { env } from "cloudflare:workers";
import { isContentCollection } from "@inaridiy/content-contract";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	buildEntryDocs,
	docMetadata,
	hashContent,
	renderDoc,
} from "./docs";

/**
 * Search-sync plugin (runtime). See ./index.ts for the overview.
 *
 * Hook ordering: priority 200 runs AFTER the auto-translator (priority 100,
 * same events), and the entry is re-read via ctx.content.get() instead of
 * trusting the event payload — so freshly written `*_en` fields are indexed
 * in the same request.
 */

function getSearchBinding(): AiSearchInstance | undefined {
	return (env as Partial<Env>).SEARCH;
}

function isIndexedCollection(collection: string): boolean {
	return isContentCollection(collection);
}

async function listAllItems(search: AiSearchInstance) {
	const items: Array<{ id: string; key: string; metadata?: Record<string, unknown> }> = [];
	let page = 1;
	for (;;) {
		const response = await search.items.list({ page, per_page: 100 });
		items.push(...response.result);
		const info = response.result_info;
		if (!info || page * info.per_page >= info.total_count || response.result.length === 0) {
			break;
		}
		page++;
	}
	return items;
}

async function deleteItems(
	search: AiSearchInstance,
	ctx: PluginContext,
	match: (item: { key: string; metadata?: Record<string, unknown> }) => boolean,
): Promise<number> {
	const items = await listAllItems(search);
	let deleted = 0;
	for (const item of items) {
		if (!match(item)) continue;
		await search.items.delete(item.id);
		deleted++;
	}
	if (deleted > 0) ctx.log.info(`search-sync: deleted ${deleted} item(s)`);
	return deleted;
}

/** KV key remembering which item keys an entry currently owns. */
function ownedKeysKey(collection: string, id: string): string {
	return `state:keys:${collection}:${id}`;
}

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function syncEntry(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const { collection } = event;
	if (!isIndexedCollection(collection)) return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;

	const search = getSearchBinding();
	if (!search) {
		ctx.log.info("search-sync: SEARCH binding not configured, skipping");
		return;
	}

	// Re-read so we see fields written by earlier hooks (auto-translator).
	const item = await ctx.content!.get(collection, id);

	if (!item || item.status !== "published") {
		await removeEntryItems(collection, id, ctx, item?.slug ?? null);
		return;
	}

	const docs = buildEntryDocs(collection, item.slug ?? "", item.data);
	const keys: string[] = [];
	let uploaded = 0;
	for (const doc of docs) {
		keys.push(doc.key);
		const content = renderDoc(doc);
		const hash = hashContent(content);
		const hashKey = `state:hash:${doc.key}`;
		if ((await ctx.kv.get<string>(hashKey)) === hash) continue;
		await search.items.upload(doc.key, content, {
			metadata: docMetadata(doc, hash, id),
		});
		await ctx.kv.set(hashKey, hash);
		uploaded++;
	}

	// Drop keys this entry no longer produces (e.g. cleared translation)
	const previous = (await ctx.kv.get<string[]>(ownedKeysKey(collection, id))) ?? [];
	const stale = previous.filter((key) => !keys.includes(key));
	if (stale.length > 0) {
		await deleteItems(search, ctx, (candidate) => stale.includes(candidate.key));
		for (const key of stale) await ctx.kv.delete(`state:hash:${key}`);
	}
	await ctx.kv.set(ownedKeysKey(collection, id), keys);

	if (uploaded > 0) {
		ctx.log.info(`search-sync: indexed ${collection}/${item.slug} (${uploaded} doc(s))`);
	}
}

async function removeEntryItems(
	collection: string,
	id: string,
	ctx: PluginContext,
	slug: string | null,
): Promise<void> {
	const search = getSearchBinding();
	if (!search) return;

	const owned = (await ctx.kv.get<string[]>(ownedKeysKey(collection, id))) ?? [];
	await deleteItems(search, ctx, (item) => {
		if (owned.includes(item.key)) return true;
		if (item.metadata?.entryId === id) return true;
		// Fallback when KV state and metadata are both missing
		return slug !== null && item.key.startsWith(`${collection}/${slug}.`);
	});
	for (const key of owned) await ctx.kv.delete(`state:hash:${key}`);
	await ctx.kv.delete(ownedKeysKey(collection, id));
}

export default {
	hooks: {
		"content:afterSave": {
			priority: 200,
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await syncEntry(event, ctx);
			},
		},
		"content:afterPublish": {
			priority: 200,
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await syncEntry(event, ctx);
			},
		},
		"content:afterUnpublish": {
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				if (!isIndexedCollection(event.collection)) return;
				const id = typeof event.content.id === "string" ? event.content.id : null;
				const slug = typeof event.content.slug === "string" ? event.content.slug : null;
				if (id) await removeEntryItems(event.collection, id, ctx, slug);
			},
		},
		"content:afterDelete": {
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				if (!isIndexedCollection(event.collection)) return;
				await removeEntryItems(event.collection, event.id, ctx, null);
			},
		},
	},
} satisfies SandboxedPlugin;
