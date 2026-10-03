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
import {
	CONTENT_COLLECTIONS,
	getContentContract,
	getContentQueryColumns,
	isContentCollection,
	type ContentCollection,
} from "@inaridiy/content-contract";

/** Env shape this module needs. SEARCH is optional: the ai_search binding
 * only exists once the instance is created and uncommented in wrangler.jsonc. */
export interface SearchIndexEnv {
	DB: D1Database;
	SEARCH?: AiSearchInstance;
}

type Row = Record<string, unknown>;

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export function isMissingTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\bno such table\b/i.test(message);
}

async function queryPublished(
	db: D1Database,
	table: string,
	columns: string[],
): Promise<Row[] | null> {
	try {
		const { results } = await db
			.prepare(
				`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)} WHERE status = 'published'`,
			)
			.all();
		return results as Row[];
	} catch (error) {
		if (isMissingTableError(error)) {
			// A fresh database may not have been seeded yet. Crucially, the caller
			// does not treat an unscanned table as an empty authoritative source.
			console.warn({ event: "search_index_table_missing", table });
			return null;
		}
		throw error;
	}
}

interface EntryDocs {
	entryId: string;
	doc: SearchDoc;
}

interface CollectedDocs {
	docs: EntryDocs[];
	scannedCollections: Set<ContentCollection>;
}

async function collectDocs(db: D1Database): Promise<CollectedDocs> {
	const docs: EntryDocs[] = [];
	const scannedCollections = new Set<ContentCollection>();
	for (const collection of CONTENT_COLLECTIONS) {
		const contract = getContentContract(collection);
		let rows: Row[] | null;
		try {
			rows = await queryPublished(db, contract.table, getContentQueryColumns(collection));
		} catch (error) {
			console.error({
				event: "search_index_query_failed",
				collection,
				table: contract.table,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		if (rows === null) continue;
		scannedCollections.add(collection);
		for (const row of rows) {
			const entryId = typeof row.id === "string" ? row.id : "";
			const slug = typeof row.slug === "string" ? row.slug : "";
			for (const doc of buildEntryDocs(collection, slug, row)) {
				docs.push({ entryId, doc });
			}
		}
	}
	return { docs, scannedCollections };
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
	const { docs, scannedCollections } = await collectDocs(env.DB);
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
		const collection = item.metadata?.collection;
		if (typeof collection !== "string" || !isContentCollection(collection)) continue;
		if (!scannedCollections.has(collection) || wantedKeys.has(item.key)) continue;
		await env.SEARCH.items.delete(item.id);
		deleted++;
	}

	if (uploaded > 0 || deleted > 0) {
		console.log(`[search-index] reconciled: ${uploaded} uploaded, ${deleted} deleted`);
	}
}
