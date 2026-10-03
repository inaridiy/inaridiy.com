import assert from "node:assert/strict";
import test from "node:test";
import { parseEntry, serializeEntry } from "emdash-plugin-github-export/format";

test("Markdown identity metadata round-trips byte-identically", () => {
	const entry = {
		cmsId: "01KTESTCONTENTIDENTITY0000",
		slug: "renamed-post",
		status: "published",
		fields: { title: "Title", excerpt: "Summary" },
		body: "Body\n",
	};
	const serialized = serializeEntry(entry, ["title", "excerpt"]);
	assert.match(serialized, /^---\ncms_id: /);
	assert.equal(
		serializeEntry(parseEntry(serialized, "fallback"), ["title", "excerpt"]),
		serialized,
	);
});

test("legacy Markdown remains readable before its first ID migration", () => {
	const parsed = parseEntry('---\nslug: "legacy"\nstatus: "draft"\n---\n\ntext\n', "file");
	assert.equal(parsed.cmsId, undefined);
	assert.equal(parsed.slug, "legacy");
});
