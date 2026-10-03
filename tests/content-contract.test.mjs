import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CONTENT_COLLECTIONS,
	getContentContract,
	localizedPath,
} from "@inaridiy/content-contract";

const seed = JSON.parse(readFileSync(new URL("../seed/seed.json", import.meta.url), "utf8"));
const seedFields = new Map(
	seed.collections.map((collection) => [
		collection.slug,
		new Map(collection.fields.map((field) => [field.slug, field])),
	]),
);

test("content contract exhaustively covers the CMS collections", () => {
	assert.deepEqual([...seedFields.keys()], CONTENT_COLLECTIONS);
});

test("translated fields exist in the seed and are translatable", () => {
	for (const collection of CONTENT_COLLECTIONS) {
		const fields = seedFields.get(collection);
		const contract = getContentContract(collection);
		for (const slug of [...contract.strings, ...contract.portableText]) {
			const field = fields.get(slug);
			assert.ok(field, `${collection}.${slug} is missing from seed`);
			assert.notEqual(field.translatable, false, `${collection}.${slug} must be translatable`);
		}
		for (const slug of contract.portableText) {
			assert.equal(fields.get(slug).type, "portableText", `${collection}.${slug} type`);
		}
	}
});

test("every translatable seed field is either translated or deliberately shared", () => {
	for (const collection of CONTENT_COLLECTIONS) {
		const contract = getContentContract(collection);
		const translated = new Set([...contract.strings, ...contract.portableText]);
		for (const [slug, field] of seedFields.get(collection)) {
			if (field.translatable === false) continue;
			assert.ok(
				translated.has(slug),
				`${collection}.${slug} is translatable but the translator ignores it — mark it translatable: false or add it to the contract`,
			);
		}
	}
});

test("seed has no legacy *_en shadow fields", () => {
	for (const [collection, fields] of seedFields) {
		for (const slug of fields.keys()) {
			assert.ok(!slug.endsWith("_en"), `${collection}.${slug} is a legacy shadow field`);
		}
	}
});

test("public paths keep Japanese unprefixed and English under /en", () => {
	assert.equal(localizedPath("posts", "hello", "ja"), "/posts/hello");
	assert.equal(localizedPath("posts", "hello", "en"), "/en/posts/hello");
	assert.equal(localizedPath("pages", "about", "en"), "/en/about");
	assert.equal(localizedPath("pages", "now", "ja"), "/pages/now");
	assert.equal(localizedPath("activities", "anything", "en"), "/en/activities");
});
