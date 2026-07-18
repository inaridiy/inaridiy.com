import { env } from "cloudflare:workers";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Email transport plugin (runtime). See ./index.ts for the overview.
 *
 * Delivers EmDash's outgoing email (auth mail, comment notifications,
 * plugin email via ctx.email.send) through the Cloudflare Email Sending
 * binding. The `email:deliver` hook is exclusive — EmDash routes mail
 * here once this plugin is selected as the provider in Settings > Email.
 */

/** Structural view of the send_email binding (kept local so the plugin
 * package doesn't depend on the site's generated types). */
interface SendEmailLike {
	send(message: {
		to: string;
		from: { email: string; name?: string };
		subject: string;
		text: string;
		html?: string;
	}): Promise<unknown>;
}

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
	const binding = (env as { EMAIL?: SendEmailLike }).EMAIL;
	return {
		blocks: [
			{ type: "header", text: "Email Sender (Cloudflare Email Sending)" },
			{
				type: "context",
				text: "Delivers EmDash email through the send_email Worker binding — no API keys. The from address must belong to a domain onboarded to Email Sending (inaridiy.com) and be listed in allowed_sender_addresses in wrangler.jsonc. Select this plugin as the provider in Settings > Email.",
			},
			...(binding
				? []
				: [
						{
							type: "banner",
							title: "EMAIL binding not available",
							description:
								"The send_email binding only exists on the deployed Worker (or wrangler dev with remote: true). Emails cannot be delivered in this environment.",
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
				fields: [{ label: "Last delivery", value: last ? JSON.stringify(last) : "never" }],
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
				const binding = (env as { EMAIL?: SendEmailLike }).EMAIL;
				if (!binding) {
					throw new Error(
						"email-sender: send_email binding EMAIL is not available in this environment",
					);
				}
				const settings = await readSettings(ctx);
				const { message } = event;
				try {
					await binding.send({
						to: message.to,
						from: { email: settings.fromAddress, name: settings.fromName },
						subject: message.subject,
						text: message.text,
						html: message.html,
					});
					await ctx.kv.set("state:last", {
						at: new Date().toISOString(),
						ok: true,
						to: message.to,
						subject: message.subject,
						source: event.source,
					});
					ctx.log.info(`email-sender: delivered to ${message.to} (${event.source})`);
				} catch (error) {
					const detail =
						error instanceof Error
							? `${(error as Error & { code?: string }).code ?? ""} ${error.message}`.trim()
							: String(error);
					await ctx.kv.set("state:last", {
						at: new Date().toISOString(),
						ok: false,
						to: message.to,
						error: detail,
					});
					ctx.log.error(`email-sender: delivery failed: ${detail}`);
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
