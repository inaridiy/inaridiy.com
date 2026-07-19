import { env } from "cloudflare:workers";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	chunkBatch,
	hashSource,
	parseTranslatedArray,
	preparePortableText,
	SYSTEM_PROMPT,
} from "./translate";

/**
 * Auto-translation plugin (runtime).
 *
 * On publish/save of published content, translates the Japanese source
 * fields into English shadow fields (`*_en`). The site renders the `_en`
 * fields on /en/*.
 *
 * Workers AI only — the model is a plain Workers AI model id (e.g.
 * `@cf/google/gemma-4-26b-a4b-it`) called through the AI binding. No API
 * keys, no account IDs. Setting a Gateway ID routes the calls through
 * that AI Gateway (analytics / caching); it is optional.
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

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
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
}

async function readSettings(ctx: PluginContext): Promise<Settings> {
	const storedModel = (await ctx.kv.get<string>("settings:model")) || DEFAULT_MODEL;
	return {
		enabled: (await ctx.kv.get<boolean>("settings:enabled")) ?? true,
		// Accept the legacy "workers-ai/@cf/..." format from older versions
		model: storedModel.replace(/^workers-ai\//, ""),
		gatewayId: (await ctx.kv.get<string>("settings:gatewayId")) ?? "",
	};
}

/** Translate one chunk of strings via the Workers AI binding. */
async function translateChunk(
	texts: string[],
	settings: Settings,
	ctx: PluginContext,
): Promise<string[]> {
	const ai = (env as { AI?: AiBindingLike }).AI;
	if (!ai) throw new Error("Workers AI binding (AI) is not available");
	const result = (await ai.run(
		settings.model,
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
				text: "Translates published Japanese content into the *_en fields using Workers AI — no API keys. Model is a Workers AI model id (see `wrangler ai models`). Gateway ID is optional and only adds AI Gateway analytics/caching.",
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
						label: "Workers AI model",
						initial_value: settings.model,
					},
					{
						type: "text_input",
						action_id: "gatewayId",
						label: "AI Gateway ID (optional)",
						initial_value: settings.gatewayId,
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
					await ctx.kv.set(
						"settings:model",
						String(values.model ?? "")
							.trim()
							.replace(/^workers-ai\//, "") || DEFAULT_MODEL,
					);
					await ctx.kv.set("settings:gatewayId", String(values.gatewayId ?? "").trim());
					// Legacy settings from the removed HTTP gateway path
					await ctx.kv.delete("settings:accountId");
					await ctx.kv.delete("settings:apiToken");
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
