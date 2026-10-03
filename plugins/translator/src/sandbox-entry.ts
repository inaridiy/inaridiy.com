import { env } from "cloudflare:workers";
import {
	getContentContract,
	isContentCollection,
	type ContentCollectionContract,
} from "@inaridiy/content-contract";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	hashSource,
	preparePortableText,
	type CompleteRequest,
	type ProviderMetadata,
	type TranslationJobParams,
} from "./translate";

/**
 * Auto-translation plugin (runtime).
 *
 * On publish/save of published content the hook only ENQUEUES a
 * TranslatorWorkflow instance (durable, per-chunk retries). Doing the model
 * calls inline is not survivable here: afterSave/afterPublish hooks run in
 * the request's waitUntil, and Workers cancels those ~30s after the
 * response — long translations died mid-flight, taking the rest of the hook
 * chain (search-sync, github-export) with them.
 *
 * The workflow calls back into the `plan` and `complete` routes below
 * (authenticated by a KV-minted shared secret) so every content read/write
 * stays inside the plugin bridge. The write-back re-fires afterSave, which
 * re-indexes/re-exports the fresh `*_en` fields; the in-flight lease stops
 * that event from enqueueing a second job.
 *
 * TRUSTED-ONLY: reaches the TRANSLATOR_WORKFLOW binding via `import { env }
 * from "cloudflare:workers"`. Do not move to `sandboxed: []`.
 *
 * A source-content hash in KV skips retranslation when the Japanese text
 * didn't change (e.g. admin fixes a typo in the English fields).
 */

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Covers workflow runtime + step retries; `complete` releases it earlier. */
const INFLIGHT_LEASE_MS = 10 * 60 * 1_000;

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

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

interface PreparedStringField {
	source: string;
	target: string;
	text: string | null;
}

interface PreparedPortableTextField {
	source: string;
	target: string;
	prepared: ReturnType<typeof preparePortableText>;
}

interface TranslationPlan {
	sourceHash: string;
	batch: string[];
	strings: PreparedStringField[];
	portableText: PreparedPortableTextField[];
}

interface TranslationLease {
	token: string;
	sourceHash: string;
	leaseUntil: string;
}

function buildTranslationPlan(
	data: Record<string, unknown>,
	contract: ContentCollectionContract,
	settings: Settings,
): TranslationPlan {
	const strings = Object.entries(contract.translation.strings).map(([source, target]) => ({
		source,
		target,
		text:
			typeof data[source] === "string" && data[source].trim() !== ""
				? data[source]
				: null,
	}));
	const portableText = Object.entries(contract.translation.portableText).map(
		([source, target]) => ({ source, target, prepared: preparePortableText(data[source]) }),
	);
	const sourceValues = Object.fromEntries(
		[
			...strings.map(({ source }) => source),
			...portableText.map(({ source }) => source),
		].map((source) => [source, data[source] ?? null]),
	);
	const batch = [
		...strings.flatMap((entry) => (entry.text === null ? [] : [entry.text])),
		...portableText.flatMap((entry) =>
			entry.prepared.spans.map((span) => (typeof span.text === "string" ? span.text : "")),
		),
	];
	return {
		strings,
		portableText,
		batch,
		sourceHash: hashSource(
			JSON.stringify({
				model: settings.model,
				gatewayId: settings.gatewayId,
				sourceValues,
			}),
		),
	};
}

function translatedUpdates(plan: TranslationPlan, translated: string[]): Record<string, unknown> {
	const updates: Record<string, unknown> = {};
	let cursor = 0;
	for (const entry of plan.strings) {
		updates[entry.target] = entry.text === null ? "" : translated[cursor++];
	}
	for (const entry of plan.portableText) {
		for (const span of entry.prepared.spans) {
			span.text = translated[cursor++];
		}
		updates[entry.target] = entry.prepared.clone;
	}
	if (cursor !== translated.length) {
		throw new Error(
			`Translation mapping consumed ${cursor} items, received ${translated.length}`,
		);
	}
	return updates;
}

function clearedTranslationUpdates(contract: ContentCollectionContract): Record<string, unknown> {
	return {
		...Object.fromEntries(
			Object.values(contract.translation.strings).map((target) => [target, ""]),
		),
		...Object.fromEntries(
			Object.values(contract.translation.portableText).map((target) => [target, []]),
		),
	};
}

function hashKeyFor(collection: string, id: string): string {
	return `state:hash:${collection}:${id}`;
}

function inflightKeyFor(collection: string, id: string): string {
	return `state:inflight:${collection}:${id}`;
}

async function releaseLease(
	ctx: PluginContext,
	collection: string,
	id: string,
	token: unknown,
): Promise<void> {
	if (typeof token !== "string" || token === "") return;
	const key = inflightKeyFor(collection, id);
	if ((await ctx.kv.get<TranslationLease>(key))?.token === token) {
		await ctx.kv.delete(key);
	}
}

/**
 * Mint (once) the secret the workflow echoes back on plan/complete calls.
 * Concurrent first writers converge by re-reading after the write.
 */
async function ensureCallbackSecret(ctx: PluginContext): Promise<string> {
	const existing = await ctx.kv.get<string>("state:callbackSecret");
	if (existing) return existing;
	await ctx.kv.set("state:callbackSecret", crypto.randomUUID());
	return (await ctx.kv.get<string>("state:callbackSecret")) ?? "";
}

async function verifySecret(ctx: PluginContext, provided: unknown): Promise<boolean> {
	if (typeof provided !== "string" || provided === "") return false;
	const stored = await ctx.kv.get<string>("state:callbackSecret");
	if (!stored) return false;
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(stored)),
	]);
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
	return diff === 0;
}

async function recordFailure(
	ctx: PluginContext,
	details: {
		collection: string;
		id: string;
		model: string;
		error: string;
		failureKind: "enqueue" | "model_or_contract" | "persistence";
		staleTargetsCleared?: boolean;
		providerRuns?: ProviderMetadata[];
	},
): Promise<void> {
	await ctx.kv.set("state:last", {
		at: new Date().toISOString(),
		ok: false,
		...details,
	});
	ctx.log.error(
		`auto-translator: ${details.failureKind} failure for ${details.collection}/${details.id}: ${details.error}`,
	);
}

async function enqueueTranslation(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const { collection } = event;
	if (!isContentCollection(collection)) return;
	const contract = getContentContract(collection);
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;

	const settings = await readSettings(ctx);
	if (!settings.enabled) return;

	// Re-read the entry instead of trusting the (possibly slim) event payload
	const item = await ctx.content!.get(collection, id);
	if (!item || item.status !== "published") return;
	const plan = buildTranslationPlan(item.data, contract, settings);
	const hashKey = hashKeyFor(collection, id);
	if ((await ctx.kv.get<string>(hashKey)) === plan.sourceHash) return;

	// Nothing to translate (all source fields empty): write the empty
	// targets inline — no workflow needed. Hash goes first so the afterSave
	// this update re-fires sees it and cannot recurse.
	if (plan.batch.length === 0) {
		await ctx.kv.set(hashKey, plan.sourceHash);
		try {
			await ctx.content!.update!(collection, id, translatedUpdates(plan, []));
		} catch (error) {
			await ctx.kv.delete(hashKey);
			throw error;
		}
		return;
	}

	const inflightKey = inflightKeyFor(collection, id);
	const existingLease = await ctx.kv.get<TranslationLease>(inflightKey);
	if (
		existingLease?.sourceHash === plan.sourceHash &&
		Date.parse(existingLease.leaseUntil) > Date.now()
	) {
		return;
	}
	const token = crypto.randomUUID();
	await ctx.kv.set(inflightKey, {
		token,
		sourceHash: plan.sourceHash,
		leaseUntil: new Date(Date.now() + INFLIGHT_LEASE_MS).toISOString(),
	} satisfies TranslationLease);

	const workflow = (env as Partial<Env>).TRANSLATOR_WORKFLOW;
	if (!workflow) {
		await recordFailure(ctx, {
			collection,
			id,
			model: settings.model,
			error: "TRANSLATOR_WORKFLOW binding is not available",
			failureKind: "enqueue",
		});
		await releaseLease(ctx, collection, id, token);
		return;
	}

	try {
		const instance = await workflow.create({
			id: `${collection}-${id}-${plan.sourceHash}-${crypto.randomUUID().slice(0, 8)}`,
			params: {
				collection,
				id,
				sourceHash: plan.sourceHash,
				leaseToken: token,
				secret: await ensureCallbackSecret(ctx),
			} satisfies TranslationJobParams,
		});
		ctx.log.info(
			`auto-translator: enqueued workflow ${instance.id} for ${collection}/${id} (${plan.batch.length} segments)`,
		);
	} catch (error) {
		await recordFailure(ctx, {
			collection,
			id,
			model: settings.model,
			error: error instanceof Error ? error.message : String(error),
			failureKind: "enqueue",
		});
		await releaseLease(ctx, collection, id, token);
	}
}

/* ------------------------------------------------------------------ */
/* Workflow callback routes                                            */
/* ------------------------------------------------------------------ */

interface RouteInput {
	input: unknown;
}

function parseJobFields(input: unknown): TranslationJobParams | null {
	if (typeof input !== "object" || input === null) return null;
	const record = input as Record<string, unknown>;
	if (
		typeof record.collection !== "string" ||
		typeof record.id !== "string" ||
		typeof record.sourceHash !== "string" ||
		typeof record.leaseToken !== "string" ||
		typeof record.secret !== "string"
	) {
		return null;
	}
	return record as unknown as TranslationJobParams;
}

/**
 * Returns the translation batch for a job, or ok:false when the job is
 * obsolete (entry unpublished or source changed since enqueue). Obsolete
 * jobs release their lease so a follow-up save can enqueue immediately.
 */
async function handlePlan(routeCtx: RouteInput, ctx: PluginContext) {
	const job = parseJobFields(routeCtx.input);
	if (!job || !(await verifySecret(ctx, job.secret))) {
		return { ok: false, unauthorized: true };
	}
	if (!isContentCollection(job.collection)) return { ok: false, reason: "bad_collection" };
	const settings = await readSettings(ctx);
	const item = await ctx.content!.get(job.collection, job.id);
	const plan =
		item && item.status === "published"
			? buildTranslationPlan(item.data, getContentContract(job.collection), settings)
			: null;
	if (!plan || plan.sourceHash !== job.sourceHash) {
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: false, reason: "stale" };
	}
	return { ok: true, batch: plan.batch, model: settings.model, gatewayId: settings.gatewayId };
}

/** Persists a finished job: translated updates on success, target clear on failure. */
async function handleComplete(routeCtx: RouteInput, ctx: PluginContext) {
	const job = parseJobFields(routeCtx.input);
	if (!job || !(await verifySecret(ctx, job.secret))) {
		return { ok: false, unauthorized: true };
	}
	if (!isContentCollection(job.collection)) return { ok: false, reason: "bad_collection" };
	const request = routeCtx.input as CompleteRequest;
	const contract = getContentContract(job.collection);
	const settings = await readSettings(ctx);
	const hashKey = hashKeyFor(job.collection, job.id);
	const item = await ctx.content!.get(job.collection, job.id);
	const plan =
		item && item.status === "published"
			? buildTranslationPlan(item.data, contract, settings)
			: null;
	const planIsCurrent = plan !== null && plan.sourceHash === job.sourceHash;

	if (typeof request.error === "string") {
		// The workflow exhausted its retries. Clear the (now stale) targets so
		// /en falls back to Japanese instead of showing an outdated translation —
		// but only while this job still describes the live source.
		let staleTargetsCleared = false;
		if (planIsCurrent && (await ctx.kv.get<string>(hashKey)) !== job.sourceHash) {
			try {
				await ctx.content!.update!(job.collection, job.id, clearedTranslationUpdates(contract));
				staleTargetsCleared = true;
			} catch (clearError) {
				ctx.log.error(
					`auto-translator: could not clear stale targets for ${job.collection}/${job.id}: ${
						clearError instanceof Error ? clearError.message : String(clearError)
					}`,
				);
			}
		}
		await recordFailure(ctx, {
			collection: job.collection,
			id: job.id,
			model: settings.model,
			error: request.error,
			failureKind: "model_or_contract",
			staleTargetsCleared,
			providerRuns: request.providerRuns ?? [],
		});
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: true };
	}

	if (!planIsCurrent) {
		ctx.log.info(`auto-translator: discarded stale result for ${job.collection}/${job.id}`);
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: false, reason: "stale" };
	}
	if (!Array.isArray(request.translations)) return { ok: false, reason: "bad_request" };

	try {
		await ctx.content!.update!(
			job.collection,
			job.id,
			translatedUpdates(plan, request.translations),
		);
	} catch (error) {
		await recordFailure(ctx, {
			collection: job.collection,
			id: job.id,
			model: settings.model,
			error: error instanceof Error ? error.message : String(error),
			failureKind: "persistence",
			providerRuns: request.providerRuns ?? [],
		});
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: false, reason: "persistence" };
	}
	await ctx.kv.set(hashKey, plan.sourceHash);
	await ctx.kv.set("state:last", {
		at: new Date().toISOString(),
		collection: job.collection,
		id: job.id,
		ok: true,
		model: settings.model,
		segments: plan.batch.length,
		providerRuns: request.providerRuns ?? [],
	});
	// Release LAST: the update above re-fires afterSave, and the held lease is
	// what stops that event from enqueueing a duplicate job.
	await releaseLease(ctx, job.collection, job.id, job.leaseToken);
	ctx.log.info(
		`auto-translator: translated ${job.collection}/${job.id} (${plan.batch.length} segments)`,
	);
	return { ok: true };
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
	failureKind?: "enqueue" | "persistence" | "model_or_contract";
	staleTargetsCleared?: boolean;
	providerRuns?: ProviderMetadata[];
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
				text: "Translates published Japanese content into the *_en fields via a durable Cloudflare Workflow calling Workers AI — no API keys. Model is a Workers AI model id (see `wrangler ai models`). Gateway ID is optional and only adds AI Gateway analytics/caching.",
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
			timeout: 30000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await enqueueTranslation(event, ctx);
			},
		},
		"content:afterPublish": {
			timeout: 30000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await enqueueTranslation(event, ctx);
			},
		},
	},

	routes: {
		// Callback surface for TranslatorWorkflow (see TRANSLATOR_API in
		// ./translate). Public because the workflow has no admin session;
		// authenticated by the KV-minted shared secret instead.
		plan: { public: true, handler: handlePlan },
		complete: { public: true, handler: handleComplete },

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
