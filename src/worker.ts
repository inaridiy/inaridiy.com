// Worker entry: Astro's fetch handler plus EmDash's scheduled() handler
// (scheduled publishing, plugin cron, maintenance). PluginBridge is the
// sandbox Durable Object, re-exported here so its binding resolves.
import emdashWorker, {
	PluginBridge,
	createScheduledHandler,
} from "@emdash-cms/cloudflare/worker";

const emdashScheduled = createScheduledHandler();

/**
 * Canonical host. Requests on the old domain (inaridiy.com, still attached
 * to this Worker as a custom domain) and *.workers.dev are redirected here
 * with path and query intact.
 *
 * The Workers Cache key does not include the hostname, so a cacheable
 * redirect for inaridiy.com/ would be served for inari.diy/ as well (a
 * self-redirect loop). Redirects must stay `no-store`.
 */
const CANONICAL_HOST = "inari.diy";
const LEGACY_HOSTS = new Set(["inaridiy.com", "www.inaridiy.com"]);

function isLegacyHost(hostname: string): boolean {
	return LEGACY_HOSTS.has(hostname) || hostname.endsWith(".workers.dev");
}

const worker = {
	...emdashWorker,
	async fetch(
		request: Parameters<ExportedHandlerFetchHandler<Env>>[0],
		env: Env,
		ctx: ExecutionContext,
	) {
		const url = new URL(request.url);
		if (isLegacyHost(url.hostname)) {
			url.protocol = "https:";
			url.hostname = CANONICAL_HOST;
			url.port = "";
			// 308 keeps the method and body for API clients still on the old URL
			const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
			return new Response(null, {
				status,
				headers: { Location: url.toString(), "Cache-Control": "private, no-store" },
			});
		}
		const emdashFetch = emdashWorker.fetch;
		if (!emdashFetch) throw new Error("EmDash Worker did not export a fetch handler");
		return emdashFetch(request, env, ctx);
	},
	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		emdashScheduled(controller, env, ctx);
	},
} satisfies ExportedHandler<Env, unknown>;

export default worker;

export { PluginBridge };
// Workflow classes must be exported from the Worker entry module or their
// bindings fail to resolve.
export { TranslatorWorkflow } from "./translator-workflow";
