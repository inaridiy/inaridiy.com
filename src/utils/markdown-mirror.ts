/**
 * Shared helpers for the AI-native markdown mirrors:
 * /llms.txt, /llms-full.txt, /posts/<slug>.md, /en/posts/<slug>.md, /about.md.
 *
 * Portable Text -> Markdown reuses the official lossless converter from
 * `emdash/client` — the same one the github-sync plugin and its CLI build
 * their Markdown files with (headings, nested
 * lists, links, marks, code fences with language, images; unknown custom
 * blocks survive as opaque `<!--ec:block ... -->` fences).
 */
import { localizedPath, type ContentLocale } from "@inaridiy/content-contract";
import type {
	CacheHint,
	ContentEntry,
	InferCollectionData,
	PortableTextBlock,
} from "emdash";
import { getEmDashCollection } from "emdash";
import { portableTextToMarkdown } from "emdash/client";

export type PostEntry = ContentEntry<InferCollectionData<"posts">>;
export type PageEntry = ContentEntry<InferCollectionData<"pages">>;

/**
 * All published posts, newest first. Cursor-paginated so the llms routes
 * keep working past the first page; every page's cacheHint is collected —
 * callers must pass each one to `cache.set()` so the responses carry the
 * same Cache-Tags (collection + entry ULIDs) as the HTML pages.
 */
export async function fetchAllPublishedPosts(locale: ContentLocale = "ja"): Promise<{
	posts: PostEntry[];
	cacheHints: CacheHint[];
}> {
	const posts: PostEntry[] = [];
	const cacheHints: CacheHint[] = [];
	let cursor: string | undefined;
	do {
		const { entries, nextCursor, cacheHint } = await getEmDashCollection("posts", {
			locale,
			status: "published",
			orderBy: { published_at: "desc" },
			limit: 100,
			cursor,
		});
		posts.push(...entries);
		cacheHints.push(cacheHint);
		cursor = nextCursor;
	} while (cursor);
	return { posts, cacheHints };
}

/** JSON string escaping doubles as valid YAML double-quoted scalars. */
const yamlText = (value: string): string => JSON.stringify(value);
const yamlList = (values: string[]): string => `[${values.map(yamlText).join(", ")}]`;

/** Collapse a value to a single line (llms.txt list descriptions). */
export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Portable Text body -> Markdown with a single trailing newline. */
export function postBodyMarkdown(content: PortableTextBlock[] | undefined): string {
	return `${portableTextToMarkdown(content ?? []).trimEnd()}\n`;
}

export interface PostMarkdownOptions {
	lang: ContentLocale;
	/** For `lang: "en"`: false when the page fell back to the Japanese entry. */
	translated?: boolean;
	/** For `lang: "en"`: public path of the Japanese original. */
	originalPath?: string;
}

/** One post as a standalone Markdown document (frontmatter + body). */
export function postToMarkdown(
	post: PostEntry,
	origin: string,
	{ lang, translated = false, originalPath }: PostMarkdownOptions,
): string {
	const { title, excerpt, content } = post.data;
	// `post.id` carries a locale prefix (`en/…`) outside the default locale
	const slug = post.data.slug ?? post.id;
	const date = post.data.publishedAt?.toISOString().slice(0, 10);
	const categories = (post.data.terms?.category ?? []).map((term) => term.label);
	const tags = (post.data.terms?.tag ?? []).map((term) => term.label);

	const frontmatter: string[] = ["---", `title: ${yamlText(title)}`];
	if (date) frontmatter.push(`date: ${date}`);
	if (categories.length > 0) frontmatter.push(`categories: ${yamlList(categories)}`);
	if (tags.length > 0) frontmatter.push(`tags: ${yamlList(tags)}`);
	if (excerpt) frontmatter.push(`excerpt: ${yamlText(oneLine(excerpt))}`);
	frontmatter.push(`lang: ${lang}`);
	if (lang === "en") frontmatter.push(`translated: ${translated}`);
	frontmatter.push(`source: ${origin}${localizedPath("posts", slug, lang)}`);
	frontmatter.push("---");

	const parts = [frontmatter.join("\n"), "", `# ${title}`, ""];
	if (lang === "en") {
		parts.push(
			translated
				? `> Auto-translated from Japanese by an LLM. Original: ${origin}${originalPath ?? localizedPath("posts", slug, "ja")}`
				: `> English translation is not available yet — this is the Japanese original.`,
			"",
		);
	}
	parts.push(postBodyMarkdown(content));
	return parts.join("\n");
}

/** One `pages` entry as a standalone Markdown document. */
export function pageToMarkdown(page: PageEntry, origin: string, path: string): string {
	const frontmatter = [
		"---",
		`title: ${yamlText(page.data.title)}`,
		"lang: ja",
		`source: ${origin}${path}`,
		"---",
	];
	return [frontmatter.join("\n"), "", `# ${page.data.title}`, "", postBodyMarkdown(page.data.content)].join(
		"\n",
	);
}

/** Shared header for /llms.txt and /llms-full.txt (llms.txt convention). */
export function llmsHeader(siteTitle: string, siteTagline: string): string {
	return [
		"# inaridiy.com",
		"",
		`> ${oneLine(siteTitle)} — inaridiy の個人技術ブログ。${oneLine(siteTagline)}。日本語が原文で、/en 以下に LLM による自動英訳ミラーがあります。`,
		"",
		"記事 URL に `.md` を付けると素の Markdown が取得できます。英語版の Markdown ミラーは /en/posts/<slug>.md にあります。",
	].join("\n");
}
