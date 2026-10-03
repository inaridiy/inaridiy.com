import assert from "node:assert/strict";
import test from "node:test";
import { isMissingTableError, syncSearchIndex } from "../src/search-index.ts";

function fakeSearch(items) {
	const deleted = [];
	const uploaded = [];
	return {
		deleted,
		uploaded,
		binding: {
			items: {
				async list() {
					return {
						result: items,
						result_info: {
							count: items.length,
							page: 1,
							per_page: 100,
							total_count: items.length,
						},
					};
				},
				async upload(...args) {
					uploaded.push(args);
				},
				async delete(id) {
					deleted.push(id);
				},
			},
		},
	};
}

function fakeDb(handler) {
	return {
		prepare(sql) {
			return { all: () => handler(sql) };
		},
	};
}

async function withoutExpectedLogs(run) {
	const original = { log: console.log, warn: console.warn, error: console.error };
	console.log = () => {};
	console.warn = () => {};
	console.error = () => {};
	try {
		return await run();
	} finally {
		Object.assign(console, original);
	}
}

test("missing tables are non-authoritative and cannot trigger index deletion", async () => {
	const search = fakeSearch([
		{ id: "post", key: "posts/old.md", metadata: { collection: "posts" } },
		{ id: "page", key: "pages/old.md", metadata: { collection: "pages" } },
		{ id: "foreign", key: "other/item.md", metadata: { collection: "other" } },
	]);
	const db = fakeDb(async (sql) => {
		if (sql.includes('"ec_posts"')) throw new Error("D1_ERROR: no such table: ec_posts");
		return { results: [] };
	});

	await withoutExpectedLogs(() => syncSearchIndex({ DB: db, SEARCH: search.binding }));
	assert.deepEqual(search.deleted, ["page"]);
});

test("unexpected D1 failures abort reconciliation before any destructive action", async () => {
	const search = fakeSearch([
		{ id: "post", key: "posts/old.md", metadata: { collection: "posts" } },
	]);
	const db = fakeDb(async () => {
		throw new Error("D1_ERROR: database is locked");
	});

	await withoutExpectedLogs(() =>
		assert.rejects(() => syncSearchIndex({ DB: db, SEARCH: search.binding }), /locked/),
	);
	assert.deepEqual(search.deleted, []);
});

test("missing-table classification is intentionally narrow", () => {
	assert.equal(isMissingTableError(new Error("no such table: ec_posts")), true);
	assert.equal(isMissingTableError(new Error("database is locked")), false);
});
