/**
 * Server-side syntax highlighting for Portable Text code blocks.
 *
 * Uses shiki's pure-JavaScript regex engine — no wasm, works on Workers.
 * The grammar list is deliberately small to keep the Worker bundle lean;
 * unknown languages fall back to plain text.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const THEME = "github-dark-default";

const LANGS = [
	import("shiki/langs/typescript.mjs"),
	import("shiki/langs/tsx.mjs"),
	import("shiki/langs/javascript.mjs"),
	import("shiki/langs/json.mjs"),
	import("shiki/langs/jsonc.mjs"),
	import("shiki/langs/bash.mjs"),
	import("shiki/langs/python.mjs"),
	import("shiki/langs/rust.mjs"),
	import("shiki/langs/go.mjs"),
	import("shiki/langs/html.mjs"),
	import("shiki/langs/css.mjs"),
	import("shiki/langs/yaml.mjs"),
	import("shiki/langs/toml.mjs"),
	import("shiki/langs/sql.mjs"),
	import("shiki/langs/diff.mjs"),
	import("shiki/langs/markdown.mjs"),
	import("shiki/langs/solidity.mjs"),
];

/** Common aliases -> grammar names (shiki resolves most, this fills gaps). */
const ALIASES: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	jsx: "tsx",
	shell: "bash",
	sh: "bash",
	zsh: "bash",
	yml: "yaml",
	md: "markdown",
	py: "python",
	rs: "rust",
	golang: "go",
	astro: "typescript",
	mjs: "javascript",
	mts: "typescript",
	sol: "solidity",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
	highlighterPromise ??= createHighlighterCore({
		themes: [import("shiki/themes/github-dark-default.mjs")],
		langs: LANGS,
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	});
	return highlighterPromise;
}

/** Highlight code to HTML. Unknown languages render as plain text. */
export async function highlight(code: string, language?: string): Promise<string> {
	const highlighter = await getHighlighter();
	const requested = (language ?? "").toLowerCase();
	const lang = ALIASES[requested] ?? requested;
	const loaded = highlighter.getLoadedLanguages();
	return highlighter.codeToHtml(code, {
		lang: loaded.includes(lang) ? lang : "text",
		theme: THEME,
	});
}

/** Map a file extension to a highlight language (for GitHub embeds). */
export function languageFromPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return ALIASES[ext] ?? ext;
}
