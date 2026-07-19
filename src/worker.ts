// Worker entry: Astro's fetch handler plus EmDash's scheduled() handler
// (scheduled publishing, plugin cron, maintenance), extended with the
// AI Search sync. PluginBridge is the sandbox Durable Object, re-exported
// here so its binding resolves.
import emdashWorker, {
	PluginBridge,
	createScheduledHandler,
} from "@emdash-cms/cloudflare/worker";
import { syncSearchIndex } from "./search-index";

const emdashScheduled = createScheduledHandler();

/** Canonical host — requests on *.workers.dev are 301'd here. */
const CANONICAL_HOST = "inaridiy.com";

export default {
	...emdashWorker,
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.hostname.endsWith(".workers.dev")) {
			url.hostname = CANONICAL_HOST;
			url.port = "";
			return Response.redirect(url.toString(), 301);
		}
		const emdashFetch = (emdashWorker as unknown as Required<ExportedHandler<Env>>).fetch;
		return emdashFetch(request as Parameters<typeof emdashFetch>[0], env, ctx);
	},
	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		emdashScheduled(controller, env, ctx);
		// The cron fires every minute (EmDash needs that cadence for scheduled
		// publishing). Indexing itself is event-driven via the search-sync
		// plugin; this hourly pass only reconciles anything that slipped
		// through (missed events, manual DB edits).
		if (new Date(controller.scheduledTime).getUTCMinutes() === 0) {
			ctx.waitUntil(
				syncSearchIndex(env).catch((error) => {
					console.error("[search-index] reconciliation failed:", error);
				}),
			);
		}
	},
};

export { PluginBridge };
