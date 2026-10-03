import { describe, expect, it } from "vitest";
import {
	collectionFormat,
	entryPath,
	isSyncedEntry,
	parseEntry,
	pickFields,
	serializeEntry,
} from "../src/format.mjs";

const postFields = [
	{ slug: "title", type: "string", sortOrder: 0 },
	{ slug: "content", type: "portableText", sortOrder: 1 },
	{ slug: "excerpt", type: "text", sortOrder: 2 },
	{ slug: "featured_image", type: "image", sortOrder: 3 },
];

describe("collectionFormat", () => {
	it("puts scalar fields in frontmatter and the first rich text field in the body", () => {
		expect(collectionFormat(postFields)).toEqual({ fields: ["title", "excerpt"], body: "content" });
	});

	it("orders by schema sort order and supports frontmatter-only collections", () => {
		expect(
			collectionFormat([
				{ slug: "url", type: "url", sortOrder: 2 },
				{ slug: "title", type: "string", sortOrder: 0 },
				{ slug: "date", type: "datetime", sortOrder: 1 },
				{ slug: "slug", type: "string", sortOrder: 3 },
			]),
		).toEqual({ fields: ["title", "date", "url"], body: null });
	});
});

describe("serializeEntry / parseEntry", () => {
	const format = collectionFormat(postFields);
	const entry = {
		cmsId: "01ABC",
		slug: "hello",
		status: "published",
		fields: { title: "Hello: world", excerpt: "Line \"quoted\"" },
		body: "# Heading\n\nText",
	};

	it("round-trips byte-identically", () => {
		const text = serializeEntry(entry, format);
		expect(text).toBe(
			'---\ncms_id: "01ABC"\nslug: "hello"\nstatus: "published"\ntitle: "Hello: world"\nexcerpt: "Line \\"quoted\\""\n---\n\n# Heading\n\nText\n',
		);
		expect(serializeEntry(parseEntry(text, "ignored"), format)).toBe(text);
	});

	it("reads hand-written files", () => {
		const parsed = parseEntry("---\r\ntitle: Plain title\r\ncount: 3\r\n---\r\nBody\r\n", "from-file");
		expect(parsed).toEqual({
			cmsId: undefined,
			slug: "from-file",
			status: "published",
			fields: { title: "Plain title", count: 3 },
			body: "Body",
		});
	});

	it("omits empty fields", () => {
		expect(serializeEntry({ ...entry, cmsId: undefined, fields: { title: "T", excerpt: "" }, body: "" }, format)).toBe(
			// Same shape as frontmatter-only files already in repos: blank body line kept.
			'---\nslug: "hello"\nstatus: "published"\ntitle: "T"\n---\n\n\n',
		);
	});
});

describe("helpers", () => {
	it("syncs only the original entry of a translation group", () => {
		expect(isSyncedEntry({ id: "a", translationGroup: "a" })).toBe(true);
		expect(isSyncedEntry({ id: "a", translationGroup: null })).toBe(true);
		expect(isSyncedEntry({ id: "b", translationGroup: "a" })).toBe(false);
	});

	it("builds paths under the configured folder", () => {
		expect(entryPath("content", "posts", "hello")).toBe("content/posts/hello.md");
		expect(entryPath("/docs/", "posts", "hello")).toBe("docs/posts/hello.md");
		expect(entryPath("", "posts", "hello")).toBe("posts/hello.md");
	});

	it("keeps scalar values only", () => {
		expect(pickFields({ title: "T", excerpt: null, featured_image: { id: "m" } }, { fields: ["title", "excerpt", "featured_image"], body: null })).toEqual({ title: "T" });
	});
});
