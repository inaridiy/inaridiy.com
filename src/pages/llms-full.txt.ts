import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";

import { fetchAllPublishedPosts, llmsHeader, postBodyMarkdown } from "../utils/markdown-mirror";
import { resolveBlogSiteIdentity } from "../utils/site-identity";

/**
 * /llms-full.txt — the llms.txt header followed by the full markdown body
 * of every published post (title + date + content), `---`-separated.
 * Cache: same pattern as rss.xml (cacheHint tags + maxAge 3600/swr).
 */
export const GET: APIRoute = async ({ cache, site, url }) => {
	const origin = site?.origin ?? url.origin;
	const { siteTitle, siteTagline } = resolveBlogSiteIdentity(await getSiteSettings());

	const { posts, cacheHints } = await fetchAllPublishedPosts();
	for (const hint of cacheHints) cache.set(hint);
	cache.set({ maxAge: 3600, swr: 86400 });

	const sections = posts.map((post) => {
		const date = post.data.publishedAt?.toISOString().slice(0, 10);
		const meta = [`- Source: ${origin}/posts/${post.data.slug ?? post.id}`];
		if (date) meta.push(`- Date: ${date}`);
		return [`# ${post.data.title}`, "", ...meta, "", postBodyMarkdown(post.data.content)].join(
			"\n",
		);
	});

	const body = [llmsHeader(siteTitle, siteTagline), ...sections].join("\n\n---\n\n");

	return new Response(`${body.trimEnd()}\n`, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
