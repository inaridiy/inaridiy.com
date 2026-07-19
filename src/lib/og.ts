/**
 * Shared OG-card rendering: dark 1200x630 PNG via satori + resvg
 * (workers-og), Noto Sans JP subset fetched per card text and cached at
 * the edge. Used by /og/site.png and /og/posts/[slug].png.
 */
import { ImageResponse } from "workers-og";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Fetch a font subset containing exactly the glyphs we render. */
export async function loadFont(text: string): Promise<ArrayBuffer> {
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

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface OgCard {
	/** Big bold heading */
	title: string;
	/** Bottom-left, brand blue */
	left: string;
	/** Bottom-right, muted (optional) */
	right?: string;
	/** Title size in px (site card uses a larger face) */
	titleSize?: number;
}

/** Render the shared dark card and return it as a PNG response. */
export async function renderOgCard(card: OgCard): Promise<Response> {
	const fontData = await loadFont(`${card.title}${card.left}${card.right ?? ""}0123456789-`);
	const titleSize = card.titleSize ?? 58;

	// Dark card matching the site theme (src/styles/theme.css). Single
	// line, no whitespace between tags: stray text nodes render as tofu
	// boxes (the font subset has no glyphs for tabs/newlines).
	const html =
		`<div style="display: flex; flex-direction: column; justify-content: space-between; width: ${OG_WIDTH}px; height: ${OG_HEIGHT}px; background: #0c0c0c; padding: 72px; font-family: 'Noto Sans JP';">` +
		`<div style="display: flex; font-size: ${titleSize}px; font-weight: 700; color: #ececec; line-height: 1.35; letter-spacing: -0.02em; overflow: hidden; max-height: 400px;">${escapeHtml(card.title)}</div>` +
		`<div style="display: flex; justify-content: space-between; align-items: center; font-size: 30px; font-weight: 700;">` +
		`<div style="display: flex; color: #4d9fff;">${escapeHtml(card.left)}</div>` +
		`<div style="display: flex; color: #8a8a93;">${escapeHtml(card.right ?? "")}</div>` +
		`</div></div>`;

	const image = new ImageResponse(html, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: [{ name: "Noto Sans JP", data: fontData, weight: 700, style: "normal" }],
	});

	return new Response(image.body, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=3600, s-maxage=86400",
		},
	});
}
