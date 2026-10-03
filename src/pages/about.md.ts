import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";

import { pageToMarkdown } from "../utils/markdown-mirror";

/**
 * Raw-markdown mirror of the about page: /about.md (`pages` collection,
 * slug `about`, same query as src/pages/about.astro). Same cache tags as
 * the HTML page; same edge TTL as PAGE_CACHE.
 */
export const GET: APIRoute = async (context) => {
	const { entry: page, cacheHint } = await getEmDashEntry("pages", "about");
	if (!page || page.data.status !== "published") {
		return new Response("Not found", {
			status: 404,
			headers: { "Cache-Control": "no-store" },
		});
	}
	context.cache.set(cacheHint);
	context.cache.set({ maxAge: 300, swr: 86400 });

	const origin = context.site?.origin ?? context.url.origin;
	return new Response(pageToMarkdown(page, origin, "/about"), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			// Browsers always revalidate; the edge (CDN-Cache-Control) answers.
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
};
