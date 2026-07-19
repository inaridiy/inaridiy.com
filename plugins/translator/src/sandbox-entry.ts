import { env } from "cloudflare:workers";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	chunkBatch,
	hashSource,
	parseTranslatedArray,
	preparePortableText,
	translateBatch,
	SYSTEM_PROMPT,
	type GatewayConfig,
} from "./translate";

/**
 * Auto-translation plugin (runtime).
 *
 * On publish/save of published content, translates the Japanese source
 * fields into English shadow fields (`*_en`). The site renders the `_en`
 * fields on /en/*.
 *
 * Model routing — the model setting is a single `{provider}/{model}` string:
 *   - `workers-ai/...` (default): calls the Workers AI binding directly.
 *     No API keys. When a gateway ID is set, requests route through that
 *     AI Gateway (analytics/caching) via the binding's gateway option.
 *   - any other provider (`openai/...`, `anthropic/...`): calls the AI
 *     Gateway unified endpoint over HTTP; requires account ID + gateway ID
 *     and BYOK provider keys stored in the gateway.
 *
 * Works with ZERO configuration out of the box (Workers AI + no gateway).
 *
 * TRUSTED-ONLY: reaches the AI binding via `import { env } from
 * "cloudflare:workers"`. Do not move to `sandboxed: []`.
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
/** Segments per model call — keeps output within model token limits. */
const CHUNK_SIZE = 40;

interface AiBindingLike {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
}

interface Settings {
	enabled: boolean;
	model: string;
	gatewayId: string;
	accountId: string;
	apiToken: string;
}

async function readSettings(ctx: PluginContext): Promise<Settings> {
	return {
		enabled: (await ctx.kv.get<boolean>("settings:enabled")) ?? true,
		model: (await ctx.kv.get<string>("settings:model")) || DEFAULT_MODEL,
		gatewayId: (await ctx.kv.get<string>("settings:gatewayId")) ?? "",
		accountId: (await ctx.kv.get<string>("settings:accountId")) ?? "",
		apiToken: (await ctx.kv.get<string>("settings:apiToken")) ?? "",
	};
}

/** Translate one chunk of strings with whichever route the model needs. */
async function translateChunk(
	texts: string[],
	settings: Settings,
	ctx: PluginContext,
): Promise<string[]> {
	if (settings.model.startsWith("workers-ai/")) {
		const ai = (env as { AI?: AiBindingLike }).AI;
		if (!ai) throw new Error("Workers AI binding (AI) is not available");
		const result = (await ai.run(
			settings.model.slice("workers-ai/".length),
			{
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: JSON.stringify(texts) },
				],
				temperature: 0.2,
				max_tokens: 4096,
			},
			settings.gatewayId ? { gateway: { id: settings.gatewayId } } : undefined,
		)) as {
			response?: unknown;
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		// Depending on the model, Workers AI returns either the legacy
		// { response } shape or an OpenAI-style chat completions envelope.
		const text =
			typeof result?.response === "string"
				? result.response
				: result?.choices?.[0]?.message?.content;
		if (typeof text !== "string" || text.trim() === "") {
			throw new Error(
				`Workers AI reply has no response text: ${JSON.stringify(result).slice(0, 300)}`,
			);
		}
		return parseTranslatedArray(text, texts.length);
	}

	// External provider — AI Gateway unified endpoint (BYOK keys live in the gateway)
	if (!settings.accountId || !settings.gatewayId) {
		throw new Error(
			`model "${settings.model}" needs the AI Gateway route: set account ID and gateway ID`,
		);
	}
	if (!ctx.http) throw new Error("network capability unavailable");
	const gateway: GatewayConfig = {
		accountId: settings.accountId,
		gatewayId: settings.gatewayId,
		model: settings.model,
		apiToken: settings.apiToken || undefined,
	};
	return translateBatch(texts, gateway, (url, init) => ctx.http!.fetch(url, init));
}

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function translateEntry(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const { collection } = event;
	const fields = COLLECTION_FIELDS[collection];
	if (!fields) return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;

	const settings = await readSettings(ctx);
	if (!settings.enabled) return;

	// Re-read the entry instead of trusting the (possibly slim) event payload
	const item = await ctx.content!.get(collection, id);
	if (!item || item.status !== "published") return;
	const data = item.data;

	// Collect translatable source strings in a fixed order.
	const stringEntries = Object.entries(fields.strings).filter(
		([source]) => typeof data[source] === "string" && String(data[source]).trim() !== "",
	);
	const ptEntries = Object.entries(fields.portableText).map(([source, target]) => ({
		source,
		target,
		prepared: preparePortableText(data[source]),
	}));

	const batch: string[] = [
		...stringEntries.map(([source]) => String(data[source])),
		...ptEntries.flatMap((entry) => entry.prepared.spans.map((span) => String(span.text))),
	];
	if (batch.length === 0) return;

	// Skip when the Japanese source is unchanged since the last translation.
	const hashKey = `state:hash:${collection}:${id}`;
	const sourceHash = hashSource(JSON.stringify(batch));
	if ((await ctx.kv.get<string>(hashKey)) === sourceHash) return;

	try {
		const translated: string[] = [];
		for (const chunk of chunkBatch(batch, CHUNK_SIZE)) {
			translated.push(...(await translateChunk(chunk, settings, ctx)));
		}

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

	return {
		blocks: [
			{ type: "header", text: "Auto Translator" },
			{
				type: "context",
				text: "Translates published Japanese content into the *_en fields. Default model runs on Workers AI — no keys needed; set a gateway ID to route it through an AI Gateway. External models (openai/gpt-4o-mini, anthropic/claude-sonnet-4-5, ...) additionally need the account ID and BYOK keys stored in the gateway.",
			},
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
						action_id: "model",
						label: "Model ({provider}/{model})",
						initial_value: settings.model,
					},
					{
						type: "text_input",
						action_id: "gatewayId",
						label: "AI Gateway ID (optional for workers-ai)",
						initial_value: settings.gatewayId,
					},
					{
						type: "text_input",
						action_id: "accountId",
						label: "Cloudflare account ID (external providers only)",
						initial_value: settings.accountId,
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
				await translateEntry(event, ctx);
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
					await ctx.kv.set("settings:model", String(values.model ?? "").trim() || DEFAULT_MODEL);
					await ctx.kv.set("settings:gatewayId", String(values.gatewayId ?? "").trim());
					await ctx.kv.set("settings:accountId", String(values.accountId ?? "").trim());
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
