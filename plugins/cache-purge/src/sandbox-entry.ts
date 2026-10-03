import { cache } from "cloudflare:workers";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Cache-purge plugin (runtime). See ./index.ts for the overview.
 *
 * Hook ordering: priority 90 runs before EmDash's aiSearch() hooks (default
 * 100, errorPolicy "abort"), so a slow AI Search call cannot skip the purge.
 * The translator writes English entries from its own workflow callback,
 * which fires these hooks again for the English entry.
 * afterSave also covers draft saves — a wasted purge for public pages, but
 * it keeps preview URLs (same path, `?preview=` query) from serving stale
 * drafts out of the edge cache.
 */

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function purgeTags(tags: string[], ctx: PluginContext): Promise<void> {
	try {
		const result = await cache.purge({ tags });
		if (!result.success) {
			ctx.log.warn("cache-purge: purge reported errors", result.errors);
		}
	} catch (error) {
		// Local dev (no Workers Cache API) lands here; deployed pages then
		// simply age out via their Cloudflare-CDN-Cache-Control maxAge/swr.
		ctx.log.info(
			`cache-purge: skipped (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

function contentHook() {
	return {
		priority: 90,
		timeout: 10000,
		errorPolicy: "continue" as const,
		handler: async (event: ContentEvent, ctx: PluginContext) => {
			const tags = [event.collection];
			if (typeof event.content.id === "string") tags.push(event.content.id);
			await purgeTags(tags, ctx);
		},
	};
}

export default {
	hooks: {
		"content:afterSave": contentHook(),
		"content:afterPublish": contentHook(),
		"content:afterUnpublish": contentHook(),
		"content:afterDelete": {
			priority: 90,
			timeout: 10000,
			errorPolicy: "continue" as const,
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await purgeTags([event.collection, event.id], ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
