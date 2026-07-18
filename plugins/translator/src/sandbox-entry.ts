import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	hashSource,
	preparePortableText,
	translateBatch,
	type GatewayConfig,
} from "./translate";

/**
 * Auto-translation plugin (runtime).
 *
 * On publish/save of published content, translates the Japanese source
 * fields into English shadow fields (`*_en`) through the Cloudflare AI
 * Gateway unified endpoint. The site renders the `_en` fields on /en/*.
 *
 * The model is a single `{provider}/{model}` string, so switching models
 * (Workers AI, OpenAI, Anthropic, ...) is a settings change in the admin —
 * provider API keys are stored in the AI Gateway (BYOK), never here.
 *
 * A source-content hash in KV skips retranslation when the Japanese text
 * didn't change (e.g. admin fixes a typo in the English fields).
 */

/** source field -> translated shadow field, per collection */
const COLLECTION_FIELDS: Record<
	string,
	{ strings: Record<string, string>; portableText: Record<string, string> }
> = {
	posts: {
		strings: { title: "title_en", excerpt: "excerpt_en" },
		portableText: { content: "content_en" },
	},
	pages: {
		strings: { title: "title_en" },
		portableText: { content: "content_en" },
	},
	activities: {
		strings: { title: "title_en", description: "description_en" },
		portableText: {},
	},
};

const DEFAULT_MODEL = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface Settings {
	enabled: boolean;
	accountId: string;
	gatewayId: string;
	model: string;
	apiToken: string;
}

async function readSettings(ctx: PluginContext): Promise<Settings> {
	return {
		enabled: (await ctx.kv.get<boolean>("settings:enabled")) ?? true,
		accountId: (await ctx.kv.get<string>("settings:accountId")) ?? "",
		gatewayId: (await ctx.kv.get<string>("settings:gatewayId")) ?? "",
		model: (await ctx.kv.get<string>("settings:model")) || DEFAULT_MODEL,
		apiToken: (await ctx.kv.get<string>("settings:apiToken")) ?? "",
	};
}

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function translateEntry(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const { collection, content } = event;
	const fields = COLLECTION_FIELDS[collection];
	if (!fields) return;

	const id = typeof content.id === "string" ? content.id : null;
	if (!id) return;
	// Drafts are translated when they get published (content:afterPublish).
	if (content.status !== undefined && content.status !== "published") return;

	const settings = await readSettings(ctx);
	if (!settings.enabled) return;
	if (!settings.accountId || !settings.gatewayId) {
		ctx.log.warn(
			"auto-translator: AI Gateway not configured (set account/gateway in Admin -> Translator)",
		);
		return;
	}

	// Collect translatable source strings in a fixed order.
	const stringEntries = Object.entries(fields.strings).filter(
		([source]) => typeof content[source] === "string" && String(content[source]).trim() !== "",
	);
	const ptEntries = Object.entries(fields.portableText).map(([source, target]) => ({
		source,
		target,
		prepared: preparePortableText(content[source]),
	}));

	const batch: string[] = [
		...stringEntries.map(([source]) => String(content[source])),
		...ptEntries.flatMap((entry) => entry.prepared.spans.map((span) => String(span.text))),
	];
	if (batch.length === 0) return;

	// Skip when the Japanese source is unchanged since the last translation.
	const hashKey = `state:hash:${collection}:${id}`;
	const sourceHash = hashSource(JSON.stringify(batch));
	if ((await ctx.kv.get<string>(hashKey)) === sourceHash) return;

	if (!ctx.http) {
		ctx.log.warn("auto-translator: network capability unavailable");
		return;
	}

	const gateway: GatewayConfig = {
		accountId: settings.accountId,
		gatewayId: settings.gatewayId,
		model: settings.model,
		apiToken: settings.apiToken || undefined,
	};

	try {
		const translated = await translateBatch(batch, gateway, (url, init) =>
			ctx.http!.fetch(url, init),
		);

		const updates: Record<string, unknown> = {};
		let cursor = 0;
		for (const [, target] of stringEntries) {
			updates[target] = translated[cursor++];
		}
		for (const entry of ptEntries) {
			for (const span of entry.prepared.spans) {
				span.text = translated[cursor++];
			}
			if (entry.prepared.clone.length > 0) {
				updates[entry.target] = entry.prepared.clone;
			}
		}

		await ctx.content!.update!(collection, id, updates);
		await ctx.kv.set(hashKey, sourceHash);
		await ctx.kv.set("state:last", {
			at: new Date().toISOString(),
			collection,
			id,
			ok: true,
			model: settings.model,
			segments: batch.length,
		});
		ctx.log.info(`auto-translator: translated ${collection}/${id} (${batch.length} segments)`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await ctx.kv.set("state:last", {
			at: new Date().toISOString(),
			collection,
			id,
			ok: false,
			model: settings.model,
			error: message,
		});
		ctx.log.error(`auto-translator: failed for ${collection}/${id}: ${message}`);
	}
}

/* ------------------------------------------------------------------ */
/* Block Kit admin page                                                */
/* ------------------------------------------------------------------ */

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

interface LastRun {
	at: string;
	collection: string;
	id: string;
	ok: boolean;
	model: string;
	segments?: number;
	error?: string;
}

async function settingsBlocks(ctx: PluginContext) {
	const settings = await readSettings(ctx);
	const last = await ctx.kv.get<LastRun>("state:last");
	const configured = Boolean(settings.accountId && settings.gatewayId);

	return {
		blocks: [
			{ type: "header", text: "Auto Translator" },
			{
				type: "context",
				text: "Translates published Japanese content into the *_en fields via Cloudflare AI Gateway. Model format: {provider}/{model} — e.g. workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast, openai/gpt-4o-mini, anthropic/claude-sonnet-4-5. Store provider API keys in the AI Gateway (BYOK).",
			},
			...(configured
				? []
				: [
						{
							type: "banner",
							title: "Not configured",
							description:
								"Set your Cloudflare account ID and AI Gateway ID to enable translation.",
							variant: "alert",
						},
					]),
			{
				type: "form",
				block_id: "settings",
				fields: [
					{
						type: "toggle",
						action_id: "enabled",
						label: "Enabled",
						initial_value: settings.enabled,
					},
					{
						type: "text_input",
						action_id: "accountId",
						label: "Cloudflare account ID",
						initial_value: settings.accountId,
					},
					{
						type: "text_input",
						action_id: "gatewayId",
						label: "AI Gateway ID",
						initial_value: settings.gatewayId,
					},
					{
						type: "text_input",
						action_id: "model",
						label: "Model ({provider}/{model})",
						initial_value: settings.model,
					},
					{
						type: "secret_input",
						action_id: "apiToken",
						label: "Gateway token (cf-aig-authorization, optional)",
					},
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
			{ type: "divider" },
			{
				type: "fields",
				fields: [
					{
						label: "Last run",
						value: last
							? `${last.at} — ${last.collection}/${last.id} — ${
									last.ok ? `ok (${last.segments} segments, ${last.model})` : `error: ${last.error}`
								}`
							: "never",
					},
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "Reset translation cache",
						action_id: "reset_cache",
						confirm: {
							title: "Reset translation cache?",
							text: "All content will be re-translated on its next save/publish.",
							confirm: "Reset",
							deny: "Cancel",
						},
					},
				],
			},
		],
	};
}

export default {
	hooks: {
		"content:afterSave": {
			timeout: 120000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await translateEntry(event, ctx);
			},
		},
		"content:afterPublish": {
			timeout: 120000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await translateEntry({ ...event, content: { ...event.content, status: "published" } }, ctx);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					await ctx.kv.set("settings:enabled", Boolean(values.enabled));
					await ctx.kv.set("settings:accountId", String(values.accountId ?? "").trim());
					await ctx.kv.set("settings:gatewayId", String(values.gatewayId ?? "").trim());
					await ctx.kv.set("settings:model", String(values.model ?? "").trim() || DEFAULT_MODEL);
					const token = String(values.apiToken ?? "").trim();
					// Empty secret input means "keep the stored token"
					if (token !== "") await ctx.kv.set("settings:apiToken", token);
					return {
						...(await settingsBlocks(ctx)),
						toast: { message: "Settings saved", type: "success" },
					};
				}

				if (interaction.type === "block_action" && interaction.action_id === "reset_cache") {
					const entries = await ctx.kv.list("state:hash:");
					for (const entry of entries) {
						await ctx.kv.delete(entry.key);
					}
					return {
						...(await settingsBlocks(ctx)),
						toast: { message: `Cleared ${entries.length} cached hashes`, type: "success" },
					};
				}

				return settingsBlocks(ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
