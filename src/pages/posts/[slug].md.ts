import type { APIRoute } from "astro";
import { decodeSlug, getEmDashEntry } from "emdash";

import { postToMarkdown } from "../../utils/markdown-mirror";

/**
 * Raw-markdown mirror of a post: /posts/<slug>.md (JA source fields).
 * Carries the same Cache-Tags as the HTML page (cacheHint = collection +
 * entry ULID) and the same edge TTL as routeRules' PAGE_CACHE, so
 * plugins/cache-purge invalidates both together on content changes.
 */
export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return notFound();

	const { entry: post, cacheHint } = await getEmDashEntry("posts", slug, { locale: "ja" });
	if (!post || post.data.status !== "published") return notFound();
	context.cache.set(cacheHint);
	context.cache.set({ maxAge: 300, swr: 86400 });

	const origin = context.site?.origin ?? context.url.origin;
	return new Response(postToMarkdown(post, origin, { lang: "ja" }), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			// Browsers always revalidate; the edge cache answers.
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
};

const notFound = () =>
	new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
