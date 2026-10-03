import type { APIRoute } from "astro";
import { decodeSlug, getEmDashEntry } from "emdash";

import { postToMarkdown } from "../../../utils/markdown-mirror";

/**
 * Raw-markdown mirror of the English page: /en/posts/<slug>.md.
 * Field selection mirrors src/pages/en/posts/[slug].astro — `title_en`,
 * `excerpt_en`, `content_en` with fallback to the JA fields (frontmatter
 * carries `translated: false` when the English shadow content is missing).
 * Same cache tags as the HTML pages; same edge TTL as PAGE_CACHE.
 */
export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return notFound();

	const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);
	if (!post || post.data.status !== "published") return notFound();
	context.cache.set(cacheHint);
	context.cache.set({ maxAge: 300, swr: 86400 });

	const origin = context.site?.origin ?? context.url.origin;
	return new Response(postToMarkdown(post, origin, "en"), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			// Browsers always revalidate; the edge (CDN-Cache-Control) answers.
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
};

const notFound = () =>
	new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
