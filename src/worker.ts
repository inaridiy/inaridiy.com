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

export default {
	...emdashWorker,
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
