/**
 * AI Search reconciliation (cron backstop).
 *
 * The PRIMARY indexing path is event-driven: the search-sync plugin
 * (plugins/search-sync) upserts/deletes items the moment content is
 * published, updated, unpublished, or deleted. This module runs hourly
 * from the Worker cron (src/worker.ts) and reconciles D1 against the
 * AI Search instance to catch anything the event path missed (e.g.
 * events fired while the binding was down, or manual DB edits).
 *
 * Both paths share the same doc/keys/metadata/hash scheme via
 * emdash-plugin-search-sync/docs, so they are interchangeable.
 */
import {
	buildEntryDocs,
	docMetadata,
	hashContent,
	renderDoc,
	type SearchDoc,
} from "emdash-plugin-search-sync/docs";

/** Env shape this module needs. SEARCH is optional: the ai_search binding
 * only exists once the instance is created and uncommented in wrangler.jsonc. */
export interface SearchIndexEnv {
	DB: D1Database;
	SEARCH?: AiSearchInstance;
}

type Row = Record<string, unknown>;

async function queryPublished(db: D1Database, table: string, columns: string[]): Promise<Row[]> {
	try {
		const { results } = await db
			.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE status = 'published'`)
			.all();
		return results as Row[];
	} catch (error) {
		// Table may not exist yet (fresh database before first seed)
		console.warn(`[search-index] skipping ${table}:`, String(error));
		return [];
	}
}

interface EntryDocs {
	entryId: string;
	doc: SearchDoc;
}

async function collectDocs(db: D1Database): Promise<EntryDocs[]> {
	const sources: Array<{ table: string; collection: string; columns: string[] }> = [
		{
			table: "ec_posts",
			collection: "posts",
			columns: ["id", "slug", "title", "excerpt", "content", "title_en", "excerpt_en", "content_en"],
		},
		{ table: "ec_pages", collection: "pages", columns: ["id", "slug", "title", "content"] },
		{
			table: "ec_activities",
			collection: "activities",
			columns: ["id", "slug", "title", "date", "kind", "url", "description"],
		},
	];

	const docs: EntryDocs[] = [];
	for (const source of sources) {
		const rows = await queryPublished(db, source.table, source.columns);
		for (const row of rows) {
			const entryId = typeof row.id === "string" ? row.id : "";
			const slug = typeof row.slug === "string" ? row.slug : "";
			for (const doc of buildEntryDocs(source.collection, slug, row)) {
				docs.push({ entryId, doc });
			}
		}
	}
	return docs;
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

/** Reconcile published content into the AI Search instance. Idempotent. */
export async function syncSearchIndex(env: SearchIndexEnv): Promise<void> {
	if (!env.SEARCH) return;
	const docs = await collectDocs(env.DB);
	const existing = await listAllItems(env.SEARCH);
	const existingByKey = new Map(existing.map((item) => [item.key, item]));
	const wantedKeys = new Set(docs.map(({ doc }) => doc.key));

	let uploaded = 0;
	for (const { entryId, doc } of docs) {
		const content = renderDoc(doc);
		const hash = hashContent(content);
		const current = existingByKey.get(doc.key);
		if (current?.metadata?.hash === hash) continue;
		await env.SEARCH.items.upload(doc.key, content, {
			metadata: docMetadata(doc, hash, entryId),
		});
		uploaded++;
	}

	let deleted = 0;
	for (const item of existing) {
		if (!wantedKeys.has(item.key)) {
			await env.SEARCH.items.delete(item.id);
			deleted++;
		}
	}

	if (uploaded > 0 || deleted > 0) {
		console.log(`[search-index] reconciled: ${uploaded} uploaded, ${deleted} deleted`);
	}
}
