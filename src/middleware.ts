import { defineMiddleware } from "astro:middleware";

/**
 * Browser-facing cache policy for edge-cached pages.
 *
 * Route caching emits `Cloudflare-CDN-Cache-Control` + `Cache-Tag` (consumed
 * by the Workers Cache in front of this Worker) but no `Cache-Control`.
 * Browsers ignore the CDN header and would fall back to RFC 9111 heuristic
 * freshness keyed off `Last-Modified` — i.e. keep HTML without revalidating
 * long after a publish purged the edge. Pin browsers to always revalidate;
 * the edge answers those revalidations, so this stays cheap.
 *
 * Responses that set their own Cache-Control (EmDash admin/API's
 * `private, no-store`, rss.xml, /search) are left untouched.
 *
 * The CDN header itself is applied by Astro's CacheHandler AFTER
 * middleware runs, so it can't be sniffed off the response here — read the
 * accumulated per-request cache options instead (routeRules match + the
 * page's own Astro.cache.set calls have run inside next()).
 */
export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();
	if (
		context.cache.enabled &&
		context.cache.options.maxAge !== undefined &&
		!response.headers.has("Cache-Control")
	) {
		response.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
	}
	return response;
});
