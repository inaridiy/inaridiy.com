import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { collectionFormat, parseEntry, serializeEntry } from "emdash-plugin-github-sync/format";

const seed = JSON.parse(readFileSync(new URL("../seed/seed.json", import.meta.url), "utf8"));

// Switching CMS -> git sync to the generic github-sync format must not
// rewrite any committed file: the schema-derived format has to reproduce
// every existing content/<collection>/*.md byte for byte.
for (const collection of seed.collections) {
	const format = collectionFormat(
		collection.fields.map((field, sortOrder) => ({ ...field, sortOrder })),
	);
	const dir = new URL(`../content/${collection.slug}/`, import.meta.url);
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
		test(`content/${collection.slug}/${file} round-trips unchanged`, () => {
			const text = readFileSync(new URL(file, dir), "utf8");
			const entry = parseEntry(text, file.replace(/\.md$/, ""));
			assert.equal(serializeEntry(entry, format), text);
		});
	}
}
