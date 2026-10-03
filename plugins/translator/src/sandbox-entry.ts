import { env } from "cloudflare:workers";
import {
	getContentContract,
	isContentCollection,
	SOURCE_LOCALE,
	TARGET_LOCALE,
	type ContentCollectionContract,
} from "@inaridiy/content-contract";
import type { PluginContentItem as ContentItem } from "emdash";
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
 * Content uses EmDash's native i18n: Japanese entries are the source and
 * each one has (at most) one English entry in its translation group. This
 * plugin owns that English entry — it creates it with `translationOf`,
 * keeps its translatable fields in sync with the source and mirrors the
 * source's publication state. Non-translatable fields (activity date/kind/
 * url, the OG image) are synced by EmDash itself.
 *
 * On publish/save of a published source the hook only ENQUEUES a
 * TranslatorWorkflow instance (durable, per-segment retries). Doing the model
 * calls inline is not survivable: afterSave/afterPublish hooks run in the
 * request's waitUntil, and Workers cancels those ~30s after the response.
 *
 * The workflow calls back into the `plan` and `complete` routes below
 * (authenticated by a KV-minted shared secret) so every content read/write
 * stays inside the plugin bridge. Writes to the English entry re-fire the
 * content hooks for that entry; they are ignored here because only source
 * locale entries are translated.
 *
 * TRUSTED-ONLY: reaches the TRANSLATOR_WORKFLOW binding via `import { env }
 * from "cloudflare:workers"`. Do not move to `sandboxed: []`.
 *
 * A source-content hash in KV (keyed by the SOURCE entry) skips
 * retranslation when the Japanese text didn't change.
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
	field: string;
	text: string | null;
}

interface PreparedPortableTextField {
	field: string;
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

function isSourceItem(item: ContentItem): boolean {
	return item.locale === null || item.locale === SOURCE_LOCALE;
}

function buildTranslationPlan(
	data: Record<string, unknown>,
	contract: ContentCollectionContract,
	settings: Settings,
): TranslationPlan {
	const strings = contract.strings.map((field) => ({
		field,
		text:
			typeof data[field] === "string" && data[field].trim() !== "" ? data[field] : null,
	}));
	const portableText = contract.portableText.map((field) => ({
		field,
		prepared: preparePortableText(data[field]),
	}));
	// Key order and shape are part of the hash: they match the hashes stored
	// before the native-i18n migration, so migrated translations are reused.
	const sourceValues = Object.fromEntries(
		[...contract.strings, ...contract.portableText].map((field) => [field, data[field] ?? null]),
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

function translatedFields(plan: TranslationPlan, translated: string[]): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	let cursor = 0;
	for (const entry of plan.strings) {
		fields[entry.field] = entry.text === null ? "" : translated[cursor++];
	}
	for (const entry of plan.portableText) {
		for (const span of entry.prepared.spans) {
			span.text = translated[cursor++];
		}
		fields[entry.field] = entry.prepared.clone;
	}
	if (cursor !== translated.length) {
		throw new Error(
			`Translation mapping consumed ${cursor} items, received ${translated.length}`,
		);
	}
	return fields;
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

/* ------------------------------------------------------------------ */
/* English entry of a source's translation group                       */
/* ------------------------------------------------------------------ */

async function findTarget(
	ctx: PluginContext,
	collection: string,
	sourceId: string,
): Promise<ContentItem | null> {
	const { translations } = await ctx.content!.getTranslations!(collection, sourceId);
	const summary = translations.find((translation) => translation.locale === TARGET_LOCALE);
	return summary ? ctx.content!.get(collection, summary.id) : null;
}

/** Create or update the English entry and publish it alongside its source. */
async function writeTarget(
	ctx: PluginContext,
	collection: string,
	source: ContentItem,
	fields: Record<string, unknown>,
): Promise<ContentItem> {
	const existing = await findTarget(ctx, collection, source.id);
	const target = existing
		? await ctx.content!.update!(collection, existing.id, fields)
		: await ctx.content!.create!(collection, fields, {
				locale: TARGET_LOCALE,
				translationOf: source.id,
			});
	if (source.status === "published") {
		const versioned = await ctx.content!.getVersioned!(collection, target.id);
		if (versioned) await ctx.content!.publish!(collection, target.id, { _rev: versioned._rev });
	}
	return target;
}

/** Take the English entry offline so /en falls back to the source. */
async function unpublishTarget(
	ctx: PluginContext,
	collection: string,
	sourceId: string,
): Promise<boolean> {
	const target = await findTarget(ctx, collection, sourceId);
	if (!target || target.status !== "published") return false;
	const versioned = await ctx.content!.getVersioned!(collection, target.id);
	if (!versioned) return false;
	await ctx.content!.unpublish!(collection, target.id, { _rev: versioned._rev });
	return true;
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
		staleTargetUnpublished?: boolean;
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

/** Reads the event's entry and returns it only when it is a published source. */
async function readPublishedSource(
	ctx: PluginContext,
	collection: string,
	id: string,
): Promise<ContentItem | null> {
	const item = await ctx.content!.get(collection, id);
	return item && isSourceItem(item) && item.status === "published" ? item : null;
}

async function enqueueTranslation(event: ContentEvent, ctx: PluginContext): Promise<void> {
	const { collection } = event;
	if (!isContentCollection(collection)) return;
	const contract = getContentContract(collection);
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;

	const settings = await readSettings(ctx);
	if (!settings.enabled) return;

	// Re-read the entry instead of trusting the (possibly slim) event payload.
	// English entries are written by this plugin and never translated.
	const item = await readPublishedSource(ctx, collection, id);
	if (!item) return;
	const plan = buildTranslationPlan(item.data, contract, settings);
	const hashKey = hashKeyFor(collection, id);
	if ((await ctx.kv.get<string>(hashKey)) === plan.sourceHash) {
		// Source unchanged, but the English entry may still be offline after a
		// re-publish of the source: bring it back with it.
		const target = await findTarget(ctx, collection, id);
		if (target && target.status !== "published") {
			const versioned = await ctx.content!.getVersioned!(collection, target.id);
			if (versioned) await ctx.content!.publish!(collection, target.id, { _rev: versioned._rev });
		}
		return;
	}

	// Nothing to translate (all source fields empty): write the empty
	// targets inline — no workflow needed.
	if (plan.batch.length === 0) {
		await writeTarget(ctx, collection, item, translatedFields(plan, []));
		await ctx.kv.set(hashKey, plan.sourceHash);
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

/** Source taken offline: take its English entry offline too. */
async function followUnpublish(event: ContentEvent, ctx: PluginContext): Promise<void> {
	if (!isContentCollection(event.collection)) return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;
	const item = await ctx.content!.get(event.collection, id);
	if (!item || !isSourceItem(item)) return;
	if (await unpublishTarget(ctx, event.collection, id)) {
		ctx.log.info(`auto-translator: unpublished English entry of ${event.collection}/${id}`);
	}
}

function pendingDeleteKeyFor(collection: string, id: string): string {
	return `state:pendingDelete:${collection}:${id}`;
}

/**
 * Before a source moves to trash, remember its English entry: once trashed,
 * the source no longer resolves its translation group.
 */
async function rememberTargetBeforeDelete(
	event: { id: string; collection: string },
	ctx: PluginContext,
): Promise<void> {
	if (!isContentCollection(event.collection)) return;
	const item = await ctx.content!.get(event.collection, event.id);
	if (!item || !isSourceItem(item)) return;
	const target = await findTarget(ctx, event.collection, event.id);
	if (target) await ctx.kv.set(pendingDeleteKeyFor(event.collection, event.id), target.id);
}

/**
 * Source trashed or deleted: trash its English entry too, so no orphaned
 * English page stays online, and forget the hash so restoring and
 * re-publishing the source retranslates (recreating the English entry).
 */
async function followDelete(event: { id: string; collection: string }, ctx: PluginContext) {
	if (!isContentCollection(event.collection)) return;
	await ctx.kv.delete(hashKeyFor(event.collection, event.id));
	const pendingKey = pendingDeleteKeyFor(event.collection, event.id);
	const targetId = await ctx.kv.get<string>(pendingKey);
	if (!targetId) return;
	await ctx.kv.delete(pendingKey);
	if (await ctx.content!.delete!(event.collection, targetId)) {
		await ctx.kv.set(trashedKeyFor(event.collection, event.id), targetId);
		ctx.log.info(`auto-translator: trashed English entry of ${event.collection}/${event.id}`);
	}
}

function trashedKeyFor(collection: string, id: string): string {
	return `state:trashed:${collection}:${id}`;
}

/**
 * Source restored from trash: restore the English entry trashed with it, so
 * it keeps its slug (a new entry would get a suffixed one). The next publish
 * of the source retranslates and republishes it.
 */
async function followRestore(event: ContentEvent, ctx: PluginContext): Promise<void> {
	if (!isContentCollection(event.collection)) return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;
	const trashedKey = trashedKeyFor(event.collection, id);
	const targetId = await ctx.kv.get<string>(trashedKey);
	if (!targetId) return;
	await ctx.kv.delete(trashedKey);
	const trashed = await ctx.content!.getTrashedVersioned!(event.collection, targetId);
	if (!trashed) return;
	await ctx.content!.restore!(event.collection, targetId, { _rev: trashed._rev });
	ctx.log.info(`auto-translator: restored English entry of ${event.collection}/${id}`);
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
 * obsolete (source unpublished or changed since enqueue). Obsolete jobs
 * release their lease so a follow-up save can enqueue immediately.
 */
async function handlePlan(routeCtx: RouteInput, ctx: PluginContext) {
	const job = parseJobFields(routeCtx.input);
	if (!job || !(await verifySecret(ctx, job.secret))) {
		return { ok: false, unauthorized: true };
	}
	if (!isContentCollection(job.collection)) return { ok: false, reason: "bad_collection" };
	const settings = await readSettings(ctx);
	const item = await readPublishedSource(ctx, job.collection, job.id);
	const plan = item
		? buildTranslationPlan(item.data, getContentContract(job.collection), settings)
		: null;
	if (!plan || plan.sourceHash !== job.sourceHash) {
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: false, reason: "stale" };
	}
	return { ok: true, batch: plan.batch, model: settings.model, gatewayId: settings.gatewayId };
}

/** Persists a finished job: English entry on success, unpublish on failure. */
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
	const item = await readPublishedSource(ctx, job.collection, job.id);
	const plan = item ? buildTranslationPlan(item.data, contract, settings) : null;
	const planIsCurrent = plan !== null && plan.sourceHash === job.sourceHash;

	if (typeof request.error === "string") {
		// The workflow exhausted its retries. Take the (now stale) English
		// entry offline so /en falls back to Japanese instead of showing an
		// outdated translation — but only while this job still describes the
		// live source.
		let staleTargetUnpublished = false;
		if (planIsCurrent && (await ctx.kv.get<string>(hashKey)) !== job.sourceHash) {
			try {
				staleTargetUnpublished = await unpublishTarget(ctx, job.collection, job.id);
			} catch (unpublishError) {
				ctx.log.error(
					`auto-translator: could not unpublish stale English entry of ${job.collection}/${job.id}: ${
						unpublishError instanceof Error ? unpublishError.message : String(unpublishError)
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
			staleTargetUnpublished,
			providerRuns: request.providerRuns ?? [],
		});
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: true };
	}

	if (!planIsCurrent || !item) {
		ctx.log.info(`auto-translator: discarded stale result for ${job.collection}/${job.id}`);
		await releaseLease(ctx, job.collection, job.id, job.leaseToken);
		return { ok: false, reason: "stale" };
	}
	if (!Array.isArray(request.translations)) return { ok: false, reason: "bad_request" };

	let target: ContentItem;
	try {
		target = await writeTarget(
			ctx,
			job.collection,
			item,
			translatedFields(plan, request.translations),
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
		targetId: target.id,
		ok: true,
		model: settings.model,
		segments: plan.batch.length,
		providerRuns: request.providerRuns ?? [],
	});
	await releaseLease(ctx, job.collection, job.id, job.leaseToken);
	ctx.log.info(
		`auto-translator: translated ${job.collection}/${job.id} -> ${target.id} (${plan.batch.length} segments)`,
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
	staleTargetUnpublished?: boolean;
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
				text: "Translates published Japanese entries into their English translation (EmDash i18n) via a durable Cloudflare Workflow calling Workers AI — no API keys. The English entry is owned by this plugin: manual edits are overwritten when the Japanese source changes. Model is a Workers AI model id (see `wrangler ai models`). Gateway ID is optional and only adds AI Gateway analytics/caching.",
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
	// Priority 50: ahead of the other content hooks, and in particular of
	// EmDash's aiSearch() hooks (default 100, errorPolicy "abort"), whose slow
	// AI Search calls time out and abort the rest of the chain.
	hooks: {
		"content:afterSave": {
			priority: 50,
			timeout: 30000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await enqueueTranslation(event, ctx);
			},
		},
		"content:afterPublish": {
			priority: 50,
			timeout: 30000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await enqueueTranslation(event, ctx);
			},
		},
		"content:afterUnpublish": {
			priority: 50,
			timeout: 30000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await followUnpublish(event, ctx);
			},
		},
		"content:afterRestore": {
			priority: 50,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await followRestore(event, ctx);
			},
		},
		"content:beforeDelete": {
			priority: 50,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await rememberTargetBeforeDelete(event, ctx);
			},
		},
		"content:afterDelete": {
			priority: 50,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await followDelete(event, ctx);
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
