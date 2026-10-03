import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CONTENT_COLLECTIONS,
	getContentContract,
	getContentQueryColumns,
} from "@inaridiy/content-contract";
import { buildEntryDocs } from "emdash-plugin-search-sync/docs";

test("content contract exhaustively covers the CMS collections", () => {
	assert.deepEqual(CONTENT_COLLECTIONS, ["posts", "pages", "activities"]);
	assert.deepEqual(getContentContract("posts").translation.strings, {
		title: "title_en",
		excerpt: "excerpt_en",
	});
	assert.ok(getContentQueryColumns("activities").includes("description_en"));
});

test("content contract query columns stay aligned with the seed schema", () => {
	const seed = JSON.parse(
		readFileSync(new URL("../seed/seed.json", import.meta.url), "utf8"),
	);
	const collections = new Map(
		seed.collections.map((collection) => [
			collection.slug,
			new Set(collection.fields.map((field) => field.slug)),
		]),
	);

	assert.deepEqual([...collections.keys()], CONTENT_COLLECTIONS);
	for (const collection of CONTENT_COLLECTIONS) {
		const seedFields = collections.get(collection);
		assert.ok(seedFields, `missing seed collection: ${collection}`);
		for (const field of getContentQueryColumns(collection)) {
			if (field === "id" || field === "slug") continue;
			assert.ok(seedFields.has(field), `${collection}.${field} is missing from seed`);
		}
	}
});

test("search projections produce Japanese and English documents for every collection", () => {
	const pageDocs = buildEntryDocs("pages", "about", {
		title: "自己紹介",
		title_en: "About",
		content: [{ _type: "block", children: [{ _type: "span", text: "日本語" }] }],
		content_en: [{ _type: "block", children: [{ _type: "span", text: "English" }] }],
	});
	assert.deepEqual(
		pageDocs.map(({ key, url, lang }) => ({ key, url, lang })),
		[
			{ key: "pages/about.md", url: "/about", lang: "ja" },
			{ key: "pages/about.en.md", url: "/en/about", lang: "en" },
		],
	);

	const activityDocs = buildEntryDocs("activities", "launch", {
		title: "公開",
		title_en: "Launch",
		date: "2026-07-19T00:00:00.000Z",
		kind: "site",
		description: "説明",
		description_en: "Description",
	});
	assert.equal(activityDocs.length, 2);
	assert.equal(activityDocs[1].url, "/en/activities");
	assert.match(activityDocs[1].body, /Description/);
});

test("an English search document is omitted until at least one shadow field exists", () => {
	const docs = buildEntryDocs("posts", "draft-translation", {
		title: "原文",
		excerpt: "概要",
		content: [],
		title_en: "",
		excerpt_en: "",
		content_en: [],
	});
	assert.deepEqual(docs.map((doc) => doc.lang), ["ja"]);
});
