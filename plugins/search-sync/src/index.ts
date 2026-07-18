import type { PluginDescriptor } from "emdash";

/**
 * Search-sync plugin (descriptor).
 *
 * Event-driven AI Search indexing: on publish/save the plugin upserts the
 * entry's search documents directly into the AI Search instance, so the
 * index follows content changes immediately instead of waiting for the
 * cron reconciliation (which stays as an hourly backstop).
 *
 * TRUSTED-ONLY: the runtime entry reaches the `SEARCH` binding through
 * `import { env } from "cloudflare:workers"`, which only exists when the
 * plugin runs in-process (`plugins: []`). Do not move it to `sandboxed: []`.
 */
export function searchSyncPlugin(): PluginDescriptor {
	return {
		id: "search-sync",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-search-sync/sandbox",
		options: {},
		capabilities: ["content:read"],
	};
}
