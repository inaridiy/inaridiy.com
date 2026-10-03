import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";
import { renderOgCard } from "../../lib/og";
import { resolveBlogSiteIdentity } from "../../utils/site-identity";

/**
 * Site-wide default OG image: /og/site.png. Used by every page that has
 * no specific image (Base.astro falls back to it). Same dark card as the
 * post OG images, with the site title as the heading.
 */
export const GET: APIRoute = async ({ cache }) => {
	cache.set({ maxAge: 3600, swr: 86400 });
	const { siteTitle, siteTagline } = resolveBlogSiteIdentity(await getSiteSettings());
	return renderOgCard({
		title: siteTitle,
		// Avoid repeating the heading when the site title IS the domain
		left: siteTitle === "inaridiy.com" ? (siteTagline ?? "") : "inaridiy.com",
		right: siteTitle === "inaridiy.com" ? undefined : siteTagline || undefined,
		titleSize: 84,
	});
};
