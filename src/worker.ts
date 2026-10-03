// Worker entry: Astro's fetch handler plus EmDash's scheduled() handler
// (scheduled publishing, plugin cron, maintenance). PluginBridge is the
// sandbox Durable Object, re-exported here so its binding resolves.
import emdashWorker, {
	PluginBridge,
	createScheduledHandler,
} from "@emdash-cms/cloudflare/worker";

const emdashScheduled = createScheduledHandler();

/** Canonical host — requests on *.workers.dev are 301'd here. */
const CANONICAL_HOST = "inaridiy.com";

const worker = {
	...emdashWorker,
	async fetch(
		request: Parameters<ExportedHandlerFetchHandler<Env>>[0],
		env: Env,
		ctx: ExecutionContext,
	) {
		const url = new URL(request.url);
		if (url.hostname.endsWith(".workers.dev")) {
			url.hostname = CANONICAL_HOST;
			url.port = "";
			return Response.redirect(url.toString(), 301);
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
