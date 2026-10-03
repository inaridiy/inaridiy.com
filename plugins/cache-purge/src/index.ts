import type { PluginDescriptor } from "emdash";

/**
 * Cache-purge plugin (descriptor).
 *
 * Purges the Workers Cache (wrangler `"cache": { "enabled": true }`) by tag
 * whenever content changes, so publishes/edits appear instantly instead of
 * waiting out the edge TTL. Pages emit `Cache-Tag` headers via Astro route
 * caching: collection queries tag responses with the collection name,
 * single-entry queries with the entry's database ULID — purging
 * `[collection, id]` clears the entry's pages and every list page in one call.
 *
 * TRUSTED-ONLY: the runtime entry calls `cache.purge()` from
 * `import { cache } from "cloudflare:workers"`, which only exists when the
 * plugin runs in-process (`plugins: []`). Do not move it to `sandboxed: []`.
 */
export function cachePurgePlugin(): PluginDescriptor {
	return {
		id: "cache-purge",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-cache-purge/sandbox",
		options: {},
		// Content hooks are gated on content:read — without it EmDash skips
		// the hook registration entirely (warns "… without content:read
		// capability — skipping"), even though the handler never reads content.
		capabilities: ["content:read"],
	};
}
