import type { APIRoute } from "astro";
import { getSiteSettings, decodeSlug } from "emdash";
import { renderOgCard } from "../../../lib/og";
import { getLocalizedEntryBySourceSlug } from "../../../utils/i18n";
import { resolveBlogSiteIdentity } from "../../../utils/site-identity";

/**
 * Auto-generated OG image for a post, keyed by the Japanese slug:
 * /og/posts/<slug>.png (?lang=en for the English entry's title).
 * Rendering lives in src/lib/og.ts.
 */
export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return new Response("Not found", { status: 404 });

	const lang = context.url.searchParams.get("lang") === "en" ? "en" : "ja";
	const { entry: post, cacheHints } = await getLocalizedEntryBySourceSlug("posts", slug, lang);
	if (!post) return new Response("Not found", { status: 404 });
	for (const cacheHint of cacheHints) context.cache.set(cacheHint);
	context.cache.set({ maxAge: 3600, swr: 86400 });

	const title = post.data.title;
	const date = post.data.publishedAt?.toISOString().slice(0, 10) ?? "";
	const { siteTitle } = resolveBlogSiteIdentity(await getSiteSettings());

	return renderOgCard({ title, left: siteTitle, right: date });
};
