import type { APIRoute } from "astro";
import { ImageResponse } from "workers-og";
import { getEmDashEntry, getSiteSettings, decodeSlug } from "emdash";
import { resolveBlogSiteIdentity } from "../../../utils/site-identity";

/**
 * Auto-generated OG image for a post: /og/posts/<slug>.png (?lang=en for
 * the translated title). Deliberately plain — white card, bold title,
 * site name in the brand blue. Rendered with satori + resvg (workers-og).
 *
 * Fonts: Noto Sans JP subset fetched from Google Fonts per title (the
 * `text=` parameter returns only the needed glyphs), cached at the edge.
 */

const WIDTH = 1200;
const HEIGHT = 630;

/** Fetch a TTF subset containing exactly the glyphs we render. */
async function loadFont(text: string): Promise<ArrayBuffer> {
	const unique = [...new Set(text)].join("");
	const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&text=${encodeURIComponent(unique)}`;
	const cache = await caches.open("og-fonts");
	const cacheKey = new Request(cssUrl);
	const cached = await cache.match(cacheKey);
	if (cached) return cached.arrayBuffer();

	// An old UA makes Google Fonts serve woff/ttf (satori cannot read woff2)
	const css = await (
		await fetch(cssUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 6.1; rv:10.0) Gecko/20100101 Firefox/10.0",
			},
		})
	).text();
	const match = css.match(
		/src:\s*url\(([^)]+)\)\s*format\(['"](?:truetype|opentype|woff)['"]\)/,
	);
	if (!match) throw new Error("Failed to resolve font subset URL");
	const fontResponse = await fetch(match[1]);
	if (!fontResponse.ok) throw new Error(`Font fetch failed: ${fontResponse.status}`);
	const buffer = await fontResponse.arrayBuffer();
	await cache.put(
		cacheKey,
		new Response(buffer, { headers: { "Cache-Control": "public, max-age=604800" } }),
	);
	return buffer;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export const GET: APIRoute = async (context) => {
	const slug = decodeSlug(context.params.slug);
	if (!slug) return new Response("Not found", { status: 404 });

	const { entry: post } = await getEmDashEntry("posts", slug);
	if (!post) return new Response("Not found", { status: 404 });

	const lang = context.url.searchParams.get("lang") === "en" ? "en" : "ja";
	const title =
		lang === "en" ? post.data.title_en || post.data.title : post.data.title;
	const date = post.data.publishedAt?.toISOString().slice(0, 10) ?? "";
	const { siteTitle } = resolveBlogSiteIdentity(await getSiteSettings());

	const fontData = await loadFont(`${title}${siteTitle}${date}0123456789-`);

	// Dark card matching the site theme (src/styles/theme.css). Single
	// line, no whitespace between tags: stray text nodes render as tofu
	// boxes (the font subset has no glyphs for tabs/newlines).
	const html =
		`<div style="display: flex; flex-direction: column; justify-content: space-between; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0c0c0c; padding: 72px; font-family: 'Noto Sans JP';">` +
		`<div style="display: flex; font-size: 58px; font-weight: 700; color: #ececec; line-height: 1.35; letter-spacing: -0.02em; overflow: hidden; max-height: 400px;">${escapeHtml(title)}</div>` +
		`<div style="display: flex; justify-content: space-between; align-items: center; font-size: 30px; font-weight: 700;">` +
		`<div style="display: flex; color: #4d9fff;">${escapeHtml(siteTitle)}</div>` +
		`<div style="display: flex; color: #8a8a93;">${escapeHtml(date)}</div>` +
		`</div></div>`;

	const image = new ImageResponse(html, {
		width: WIDTH,
		height: HEIGHT,
		fonts: [{ name: "Noto Sans JP", data: fontData, weight: 700, style: "normal" }],
	});

	return new Response(image.body, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=3600, s-maxage=86400",
		},
	});
};
