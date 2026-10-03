import type { APIRoute } from "astro";
import { decodeSlug, getEmDashEntry } from "emdash";

import { getPublishedTranslations } from "../../../utils/i18n";
import { postToMarkdown } from "../../../utils/markdown-mirror";

/**
 * Raw-markdown mirror of the English page: /en/posts/<slug>.md. Resolution
 * mirrors src/pages/en/posts/[slug].astro — the English entry, or the
 * Japanese entry via the i18n fallback chain (frontmatter then carries
 * `translated: false`). Same cache tags as the HTML pages; same edge TTL as
 * PAGE_CACHE.
 */
export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return notFound();

	const { entry: post, cacheHint, fallbackLocale } = await getEmDashEntry("posts", slug, {
		locale: "en",
	});
	if (!post || post.data.status !== "published") return notFound();
	context.cache.set(cacheHint);
	context.cache.set({ maxAge: 300, swr: 86400 });
	const translations = await getPublishedTranslations("posts", post.data.id);

	const origin = context.site?.origin ?? context.url.origin;
	return new Response(
		postToMarkdown(post, origin, {
			lang: "en",
			translated: !fallbackLocale,
			originalPath: translations.ja?.path,
		}),
		{
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				// Browsers always revalidate; the edge cache answers.
				"Cache-Control": "public, max-age=0, must-revalidate",
			},
		},
	);
};

const notFound = () =>
	new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
