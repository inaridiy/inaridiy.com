import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanTranslatedSegment,
	preparePortableText,
} from "../plugins/translator/src/translate.ts";

test("segment cleaner unwraps fences, rejects empties, keeps edge whitespace", () => {
	assert.equal(cleanTranslatedSegment("こんにちは", "Hello"), "Hello");
	assert.equal(cleanTranslatedSegment("こんにちは", "```\nHello\n```"), "Hello");
	assert.equal(cleanTranslatedSegment("こんにちは。\n", "Hello."), "Hello.\n");
	assert.equal(cleanTranslatedSegment(" 空白 ", "\nSpaces\n"), " Spaces ");
	assert.throws(() => cleanTranslatedSegment("こんにちは", "  "), /empty/);
});

test("Portable Text traversal preserves structure and skips inline code", () => {
	const source = [
		{
			_type: "block",
			children: [
				{ _type: "span", text: "translate" },
				{ _type: "span", text: "const value", marks: ["code"] },
			],
		},
	];
	const prepared = preparePortableText(source);
	assert.equal(prepared.spans.length, 1);
	prepared.spans[0].text = "translated";
	assert.equal(source[0].children[0].text, "translate");
	assert.equal(prepared.clone[0].children[1].text, "const value");
});
