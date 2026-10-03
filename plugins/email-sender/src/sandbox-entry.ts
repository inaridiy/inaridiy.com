import { env } from "cloudflare:workers";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { createEmailDeliveryMessage } from "./queue";

/**
 * Email transport plugin (runtime). See ./index.ts for the overview.
 *
 * Persists EmDash's outgoing email (auth mail, comment notifications,
 * plugin email via ctx.email.send) to Cloudflare Queues. The Worker queue
 * consumer performs the final Email Sending call. The `email:deliver` hook
 * remains exclusive, so EmDash routes mail here once selected as provider.
 */

interface Settings {
	fromAddress: string;
	fromName: string;
}

const DEFAULT_FROM = "noreply@inaridiy.com";

async function readSettings(ctx: PluginContext): Promise<Settings> {
	return {
		fromAddress: (await ctx.kv.get<string>("settings:fromAddress")) || DEFAULT_FROM,
		fromName: (await ctx.kv.get<string>("settings:fromName")) || "inaridiy.com",
	};
}

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

async function settingsBlocks(ctx: PluginContext) {
	const settings = await readSettings(ctx);
	const last = await ctx.kv.get<Record<string, unknown>>("state:last");
	const queueAvailable = Boolean(env.EMAIL_QUEUE);
	const emailAvailable = Boolean(env.EMAIL);
	return {
		blocks: [
			{ type: "header", text: "Email Sender (Cloudflare Email Sending)" },
			{
				type: "context",
				text: "Persists EmDash email to Cloudflare Queue, then the Worker consumer delivers it through Email Sending. The from address must belong to an onboarded domain and be listed in allowed_sender_addresses. Select this plugin as the provider in Settings > Email.",
			},
			...(queueAvailable && emailAvailable
				? []
				: [
						{
							type: "banner",
							title: "Email delivery bindings unavailable",
							description:
								"EMAIL_QUEUE and EMAIL must both exist on the deployed Worker. Messages cannot be durably delivered in this environment.",
							variant: "alert",
						},
					]),
			{
				type: "form",
				block_id: "settings",
				fields: [
					{
						type: "text_input",
						action_id: "fromAddress",
						label: "From address",
						initial_value: settings.fromAddress,
					},
					{
						type: "text_input",
						action_id: "fromName",
						label: "From name",
						initial_value: settings.fromName,
					},
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
			{ type: "divider" },
			{
				type: "fields",
				fields: [{ label: "Last enqueue", value: last ? JSON.stringify(last) : "never" }],
			},
		],
	};
}

export default {
	hooks: {
		"email:deliver": {
			exclusive: true,
			timeout: 30000,
			handler: async (
				event: { message: { to: string; subject: string; text: string; html?: string }; source: string },
				ctx: PluginContext,
			) => {
				if (!env.EMAIL_QUEUE) {
					throw new Error(
						"email-sender: Queue binding EMAIL_QUEUE is not available in this environment",
					);
				}
				const settings = await readSettings(ctx);
				const { message } = event;
				try {
					const queued = createEmailDeliveryMessage({
						to: message.to,
						from: { email: settings.fromAddress, name: settings.fromName },
						subject: message.subject,
						text: message.text,
						html: message.html,
						source: event.source,
					});
					await env.EMAIL_QUEUE.send(queued);
					await ctx.kv.set("state:last", {
						at: new Date().toISOString(),
						ok: true,
						deliveryId: queued.id,
						source: event.source,
					});
					ctx.log.info(`email-sender: queued ${queued.id} (${event.source})`);
				} catch (error) {
					const detail =
						error instanceof Error
							? `${(error as Error & { code?: string }).code ?? ""} ${error.message}`.trim()
							: String(error);
					await ctx.kv.set("state:last", {
						at: new Date().toISOString(),
						ok: false,
						source: event.source,
						error: detail,
					});
					ctx.log.error(`email-sender: enqueue failed: ${detail}`);
					throw error;
				}
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					const fromAddress = String(values.fromAddress ?? "").trim();
					if (fromAddress) await ctx.kv.set("settings:fromAddress", fromAddress);
					await ctx.kv.set(
						"settings:fromName",
						String(values.fromName ?? "").trim() || "inaridiy.com",
					);
					return {
						...(await settingsBlocks(ctx)),
						toast: { message: "Settings saved", type: "success" },
					};
				}
				return settingsBlocks(ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
