import { cache } from "cloudflare:workers";
import type { InvalidateOptions } from "astro";

/**
 * Astro route-cache provider for Cloudflare's Workers Cache
 * (`"cache": { "enabled": true }` in wrangler.jsonc).
 *
 * Deliberately has NO `onRequest`: the edge cache in front of the Worker
 * stores and serves responses, so the provider's only jobs are (a) existing —
 * without a configured provider Astro disables route caching and
 * `Astro.cache.set()` emits no `CDN-Cache-Control`/`Cache-Tag` headers — and
 * (b) wiring `Astro.cache.invalidate()` to `cache.purge()`. Adding an
 * `onRequest` here would make Astro strip both headers from responses
 * (see astro/core/cache/handler.js), which breaks the edge cache entirely.
 *
 * Event-driven purging on content changes lives in plugins/cache-purge; this
 * invalidate path exists so page/API code can also purge explicitly.
 */
const factory = () => ({
	name: "workers-cache",
	async invalidate(options: InvalidateOptions): Promise<void> {
		const tags =
			options.tags === undefined
				? []
				: Array.isArray(options.tags)
					? options.tags
					: [options.tags];
		if (tags.length > 0) await cache.purge({ tags });
		if (options.path) await cache.purge({ pathPrefixes: [options.path] });
	},
});

export default factory;
