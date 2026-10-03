import type { APIRoute } from "astro";
import { getEmDashEntry, getSiteSettings, decodeSlug } from "emdash";
import { renderOgCard } from "../../../lib/og";
import { resolveBlogSiteIdentity } from "../../../utils/site-identity";

/**
 * Auto-generated OG image for a post: /og/posts/<slug>.png (?lang=en for
 * the translated title). Rendering lives in src/lib/og.ts.
 */
export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return new Response("Not found", { status: 404 });

	const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);
	if (!post) return new Response("Not found", { status: 404 });
	context.cache.set(cacheHint);
	context.cache.set({ maxAge: 3600, swr: 86400 });

	const lang = context.url.searchParams.get("lang") === "en" ? "en" : "ja";
	const title =
		lang === "en" ? post.data.title_en || post.data.title : post.data.title;
	const date = post.data.publishedAt?.toISOString().slice(0, 10) ?? "";
	const { siteTitle } = resolveBlogSiteIdentity(await getSiteSettings());

	return renderOgCard({ title, left: siteTitle, right: date });
};
