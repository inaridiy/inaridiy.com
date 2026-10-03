import type { APIRoute } from "astro";
import { getEmDashEntry, getSiteSettings } from "emdash";

import { fetchAllPublishedPosts, llmsHeader, oneLine } from "../utils/markdown-mirror";
import { resolveBlogSiteIdentity } from "../utils/site-identity";

/**
 * /llms.txt — llms.txt-convention index of the raw-markdown mirrors.
 * Cache: same pattern as rss.xml (cacheHint tags + maxAge 3600/swr, purged
 * by plugins/cache-purge on content changes via the Cache-Tags).
 */
export const GET: APIRoute = async ({ cache, site, url }) => {
	const origin = site?.origin ?? url.origin;
	const { siteTitle, siteTagline } = resolveBlogSiteIdentity(await getSiteSettings());

	const [{ posts, cacheHints }, aboutResult] = await Promise.all([
		fetchAllPublishedPosts(),
		getEmDashEntry("pages", "about", { locale: "ja" }),
	]);
	for (const hint of cacheHints) cache.set(hint);
	cache.set(aboutResult.cacheHint);
	cache.set({ maxAge: 3600, swr: 86400 });

	const lines: string[] = [llmsHeader(siteTitle, siteTagline), "", "## Posts", ""];
	for (const post of posts) {
		const link = `[${post.data.title}](${origin}/posts/${post.id}.md)`;
		lines.push(post.data.excerpt ? `- ${link}: ${oneLine(post.data.excerpt)}` : `- ${link}`);
	}

	const about = aboutResult.entry;
	if (about && about.data.status === "published") {
		lines.push("", "## Pages", "", `- [${about.data.title}](${origin}/about.md): 自己紹介`);
	}

	lines.push(
		"",
		"## Optional",
		"",
		`- [llms-full.txt](${origin}/llms-full.txt): 全公開記事の本文を 1 ファイルにまとめた Markdown`,
		`- [RSS](${origin}/rss.xml): RSS フィード (日本語)`,
		"",
	);

	return new Response(lines.join("\n"), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
