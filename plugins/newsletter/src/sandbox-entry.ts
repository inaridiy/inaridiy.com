import { env } from "cloudflare:workers";
import type { StorageCollection } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Double-opt-in subscriptions and resumable new-post campaigns.
 *
 * A publish hook only records a campaign. A bounded EmDash cron sweep creates
 * per-subscriber outbox rows and sends each email through EmDash's email
 * pipeline (Cloudflare Email Sending). The outbox row is the durable record:
 * failed sends are retried with backoff until MAX_SEND_ATTEMPTS. A campaign
 * is complete only after every eligible subscriber has a terminal state.
 */

const SITE_URL = "https://inaridiy.com";
const SITE_NAME = "inaridiy.com";
const CAMPAIGN_CRON = "newsletter-dispatch";
const CAMPAIGN_SCHEDULE = "*/5 * * * *";
const SUBSCRIBER_PAGE_SIZE = 50;
const RETRY_PAGE_SIZE = 20;
const MAX_SEND_ATTEMPTS = 8;
const RESEND_THROTTLE_MS = 24 * 60 * 60 * 1000;
const CONFIRM_LEASE_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Subscriber {
	email: string;
	status: "pending" | "confirmed";
	token: string;
	createdAt: string;
	confirmSentAt?: string;
	confirmLeaseUntil?: string;
	confirmedAt?: string;
}

type CampaignStatus = "pending" | "running" | "complete" | "partial";

interface Campaign {
	postId: string;
	slug: string;
	title: string;
	excerpt: string;
	status: CampaignStatus;
	subscriberCutoff: string;
	subscriberCursor?: string;
	enumerationComplete: boolean;
	createdAt: string;
	updatedAt: string;
	sent: number;
	/** Pre-2026-10 campaigns counted Queue hand-offs under this name. */
	queued?: number;
	failed: number;
	dead: number;
	skipped: number;
}

/** "queued" is the legacy name of "sent" from the Queue-backed transport. */
type DeliveryStatus = "pending" | "failed" | "sent" | "queued" | "dead" | "skipped";

interface Delivery {
	campaignId: string;
	subscriberId: string;
	to: string;
	unsubscribeToken: string;
	status: DeliveryStatus;
	attempts: number;
	nextAttemptAt: string;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

function subscribers(ctx: PluginContext): StorageCollection<Subscriber> {
	return ctx.storage.subscribers as StorageCollection<Subscriber>;
}

function campaigns(ctx: PluginContext): StorageCollection<Campaign> {
	return ctx.storage.campaigns as StorageCollection<Campaign>;
}

function deliveries(ctx: PluginContext): StorageCollection<Delivery> {
	return ctx.storage.deliveries as StorageCollection<Delivery>;
}

async function findByEmail(ctx: PluginContext, email: string) {
	const result = await subscribers(ctx).query({ where: { email }, limit: 1 });
	return result.items[0] ?? null;
}

async function findByToken(ctx: PluginContext, token: string) {
	if (!token) return null;
	const result = await subscribers(ctx).query({ where: { token }, limit: 1 });
	return result.items[0] ?? null;
}

function parseEmail(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const email = input.trim().toLowerCase();
	return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkSubscriptionRateLimit(
	email: string,
): Promise<"allowed" | "limited" | "unavailable"> {
	const limiter = (env as Partial<Env>).NEWSLETTER_RATE_LIMITER;
	if (!limiter) return "allowed"; // Local dev without Wrangler bindings.
	try {
		const result = await limiter.limit({ key: `newsletter:${await sha256(email)}` });
		return result.success ? "allowed" : "limited";
	} catch {
		return "unavailable";
	}
}

async function sendConfirmEmail(ctx: PluginContext, subscriber: Subscriber): Promise<void> {
	await ctx.email!.send({
		to: subscriber.email,
		subject: `${SITE_NAME} の購読確認`,
		text: [
			`${SITE_NAME} の新着記事メールの購読手続きです。`,
			"",
			"以下のリンクを開くと購読が完了します:",
			`${SITE_URL}/newsletter/confirm?token=${encodeURIComponent(subscriber.token)}`,
			"",
			"心当たりがない場合はこのメールを無視してください。",
		].join("\n"),
	});
}

async function ensureCampaignCron(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) {
		ctx.log.warn("newsletter: cron scheduler unavailable; campaigns will not dispatch");
		return;
	}
	await ctx.cron.schedule(CAMPAIGN_CRON, { schedule: CAMPAIGN_SCHEDULE });
}

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function createCampaign(event: ContentEvent, ctx: PluginContext): Promise<void> {
	if (event.collection !== "posts") return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id || (await campaigns(ctx).exists(id))) return;

	const item = await ctx.content!.get("posts", id);
	if (!item || item.status !== "published" || !item.slug) return;
	// Announce Japanese posts only: English entries are translations of them.
	if (item.locale && item.locale !== "ja") return;
	const now = new Date().toISOString();
	await campaigns(ctx).put(id, {
		postId: id,
		slug: item.slug,
		title: typeof item.data.title === "string" ? item.data.title : item.slug,
		excerpt: typeof item.data.excerpt === "string" ? item.data.excerpt : "",
		status: "pending",
		subscriberCutoff: now,
		enumerationComplete: false,
		createdAt: now,
		updatedAt: now,
		sent: 0,
		failed: 0,
		dead: 0,
		skipped: 0,
	});
	await ensureCampaignCron(ctx);
	ctx.log.info(`newsletter: campaign created for ${item.slug}`);
}

function retryAt(attempts: number): string {
	const delayMinutes = Math.min(60, 2 ** Math.min(Math.max(attempts - 1, 0), 6));
	return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

function deliveryId(campaignId: string, subscriberId: string): string {
	return `${campaignId}:${subscriberId}`;
}

async function sendDelivery(
	id: string,
	delivery: Delivery,
	campaign: Campaign,
	ctx: PluginContext,
): Promise<void> {
	const now = new Date().toISOString();
	const subscriber = await subscribers(ctx).get(delivery.subscriberId);
	if (
		!subscriber ||
		subscriber.status !== "confirmed" ||
		!subscriber.confirmedAt ||
		subscriber.confirmedAt > campaign.subscriberCutoff
	) {
		await deliveries(ctx).put(id, {
			...delivery,
			to: "",
			unsubscribeToken: "",
			status: "skipped",
			updatedAt: now,
		});
		return;
	}

	if (!ctx.email) throw new Error("newsletter email pipeline unavailable");
	const attempts = delivery.attempts + 1;
	try {
		await ctx.email.send({
			to: delivery.to,
			subject: `${campaign.title} — ${SITE_NAME}`,
			text: [
				campaign.title,
				"",
				...(campaign.excerpt ? [campaign.excerpt, ""] : []),
				`読む: ${SITE_URL}/posts/${campaign.slug}`,
				"",
				"--",
				`配信停止: ${SITE_URL}/newsletter/unsubscribe?token=${encodeURIComponent(delivery.unsubscribeToken)}`,
			].join("\n"),
		});
		await deliveries(ctx).put(id, {
			...delivery,
			to: "",
			unsubscribeToken: "",
			status: "sent",
			attempts,
			updatedAt: now,
			lastError: undefined,
		});
	} catch (error) {
		const dead = attempts >= MAX_SEND_ATTEMPTS;
		await deliveries(ctx).put(id, {
			...delivery,
			status: dead ? "dead" : "failed",
			attempts,
			nextAttemptAt: retryAt(attempts),
			updatedAt: now,
			lastError: error instanceof Error ? error.message.slice(0, 200) : "send_failed",
		});
		ctx.log.error(
			`newsletter: send failed for delivery ${id} (attempt ${attempts}/${MAX_SEND_ATTEMPTS})`,
		);
	}
}

async function retryDeliveries(campaignId: string, campaign: Campaign, ctx: PluginContext) {
	const page = await deliveries(ctx).query({
		where: {
			campaignId,
			status: { in: ["pending", "failed"] },
			nextAttemptAt: { lte: new Date().toISOString() },
		},
		limit: RETRY_PAGE_SIZE,
	});
	for (const item of page.items) {
		await sendDelivery(item.id, item.data, campaign, ctx);
	}
}

async function enumerateSubscribers(
	campaignId: string,
	campaign: Campaign,
	ctx: PluginContext,
): Promise<Campaign> {
	if (campaign.enumerationComplete) return campaign;
	const page = await subscribers(ctx).query({
		where: {
			status: "confirmed",
			confirmedAt: { lte: campaign.subscriberCutoff },
		},
		limit: SUBSCRIBER_PAGE_SIZE,
		cursor: campaign.subscriberCursor,
	});

	for (const subscriber of page.items) {
		const id = deliveryId(campaignId, subscriber.id);
		if (await deliveries(ctx).exists(id)) continue;
		const now = new Date().toISOString();
		const delivery: Delivery = {
			campaignId,
			subscriberId: subscriber.id,
			to: subscriber.data.email,
			unsubscribeToken: subscriber.data.token,
			status: "pending",
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now,
			updatedAt: now,
		};
		// This is the outbox write. A crash after the provider accepted the
		// message may cause a retry: deliberate at-least-once, never silent loss.
		await deliveries(ctx).put(id, delivery);
		await sendDelivery(id, delivery, campaign, ctx);
	}

	return {
		...campaign,
		status: "running",
		subscriberCursor: page.cursor,
		enumerationComplete: !page.cursor,
		updatedAt: new Date().toISOString(),
	};
}

async function refreshCampaignCounts(
	campaignId: string,
	campaign: Campaign,
	ctx: PluginContext,
): Promise<Campaign> {
	const store = deliveries(ctx);
	const [sent, legacyQueued, failed, pending, dead, skipped] = await Promise.all([
		store.count({ campaignId, status: "sent" }),
		store.count({ campaignId, status: "queued" }),
		store.count({ campaignId, status: "failed" }),
		store.count({ campaignId, status: "pending" }),
		store.count({ campaignId, status: "dead" }),
		store.count({ campaignId, status: "skipped" }),
	]);
	let status: CampaignStatus = "running";
	if (campaign.enumerationComplete && failed === 0 && pending === 0) {
		status = dead > 0 ? "partial" : "complete";
	}
	return {
		...campaign,
		status,
		sent: sent + legacyQueued,
		queued: undefined,
		failed: failed + pending,
		dead,
		skipped,
		updatedAt: new Date().toISOString(),
	};
}

async function dispatchNextCampaign(ctx: PluginContext): Promise<void> {
	const page = await campaigns(ctx).query({
		where: { status: { in: ["pending", "running"] } },
		limit: 1,
	});
	const selected = page.items[0];
	if (!selected) return;
	if (!ctx.email) {
		ctx.log.warn("newsletter: campaign paused because email pipeline is unavailable");
		return;
	}

	await retryDeliveries(selected.id, selected.data, ctx);
	const enumerated = await enumerateSubscribers(selected.id, selected.data, ctx);
	const refreshed = await refreshCampaignCounts(selected.id, enumerated, ctx);
	await campaigns(ctx).put(selected.id, refreshed);
	await ctx.kv.set("state:last", {
		at: refreshed.updatedAt,
		post: refreshed.slug,
		status: refreshed.status,
		sent: refreshed.sent,
		failed: refreshed.failed,
		dead: refreshed.dead,
		skipped: refreshed.skipped,
	});
}

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
}

async function adminBlocks(ctx: PluginContext) {
	const store = subscribers(ctx);
	const [confirmed, pending, activeCampaigns] = await Promise.all([
		store.count({ status: "confirmed" }),
		store.count({ status: "pending" }),
		campaigns(ctx).count({ status: { in: ["pending", "running"] } }),
	]);
	const recent = await store.query({ orderBy: { createdAt: "desc" }, limit: 50 });
	const last = await ctx.kv.get<Record<string, unknown>>("state:last");

	return {
		blocks: [
			{ type: "header", text: "Newsletter" },
			{
				type: "stats",
				// Block Kit requires `items` here; `stats` crashes the renderer.
				items: [
					{ label: "Confirmed", value: String(confirmed) },
					{ label: "Pending", value: String(pending) },
					{ label: "Active campaigns", value: String(activeCampaigns) },
				],
			},
			{
				type: "fields",
				fields: [{ label: "Last dispatch", value: last ? JSON.stringify(last) : "never" }],
			},
			{
				type: "table",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "status", label: "Status" },
					{ key: "createdAt", label: "Subscribed" },
				],
				rows: recent.items.map(({ data }) => ({
					email: data.email,
					status: data.status,
					createdAt: data.createdAt,
				})),
			},
			{
				type: "context",
				text: "Double opt-in signup. New-post campaigns resume in bounded cron batches; every delivery is an outbox row, and failed sends retry with backoff.",
			},
		],
	};
}

export default {
	hooks: {
		"plugin:install": async (_event: unknown, ctx: PluginContext) => {
			await ensureCampaignCron(ctx);
		},
		"plugin:activate": async (_event: unknown, ctx: PluginContext) => {
			await ensureCampaignCron(ctx);
		},
		"content:afterPublish": {
			// Before aiSearch() (100, errorPolicy "abort") so a slow index
			// write cannot skip campaign creation.
			priority: 60,
			timeout: 30_000,
			errorPolicy: "continue",
			handler: createCampaign,
		},
		cron: {
			timeout: 120_000,
			errorPolicy: "continue",
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === CAMPAIGN_CRON) await dispatchNextCampaign(ctx);
			},
		},
	},

	routes: {
		subscribe: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { email?: unknown };
				const email = parseEmail(input?.email);
				if (!email) return { ok: false, error: "invalid_email" };
				const rateLimit = await checkSubscriptionRateLimit(email);
				if (rateLimit === "limited") return { ok: false, error: "rate_limited" };
				if (rateLimit === "unavailable") return { ok: false, error: "unavailable" };
				if (!ctx.email) {
					ctx.log.warn("newsletter: subscribe attempted but email pipeline unavailable");
					return { ok: false, error: "unavailable" };
				}

				const existing = await findByEmail(ctx, email);
				if (existing?.data.status === "confirmed") return { ok: true };
				const nowMs = Date.now();
				if (
					existing?.data.confirmSentAt &&
					nowMs - Date.parse(existing.data.confirmSentAt) < RESEND_THROTTLE_MS
				) {
					return { ok: true };
				}
				if (
					existing?.data.confirmLeaseUntil &&
					Date.parse(existing.data.confirmLeaseUntil) > nowMs
				) {
					return { ok: true };
				}

				const now = new Date(nowMs).toISOString();
				const recordId = existing?.id ?? crypto.randomUUID();
				const record: Subscriber = {
					...(existing?.data ?? {
						email,
						status: "pending" as const,
						token: crypto.randomUUID(),
						createdAt: now,
					}),
					confirmLeaseUntil: new Date(nowMs + CONFIRM_LEASE_MS).toISOString(),
				};
				try {
					await subscribers(ctx).put(recordId, record);
				} catch {
					// The unique email index resolves concurrent first subscriptions
					// without revealing whether the competing request won.
					return { ok: true };
				}

				try {
					await sendConfirmEmail(ctx, record);
					await subscribers(ctx).put(recordId, {
						...record,
						confirmSentAt: now,
						confirmLeaseUntil: undefined,
					});
					ctx.log.info(`newsletter: confirmation sent for subscriber ${recordId}`);
					return { ok: true };
				} catch {
					await subscribers(ctx).put(recordId, { ...record, confirmLeaseUntil: undefined });
					ctx.log.error(`newsletter: confirmation send failed for subscriber ${recordId}`);
					return { ok: false, error: "send_failed" };
				}
			},
		},

		confirm: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { token?: unknown };
				const token = typeof input?.token === "string" ? input.token.trim() : "";
				const found = await findByToken(ctx, token);
				if (!found) return { ok: false };
				await subscribers(ctx).put(found.id, {
					...found.data,
					status: "confirmed",
					confirmedAt: found.data.confirmedAt ?? new Date().toISOString(),
				});
				// Self-heal: make sure the dispatch cron exists once there is at
				// least one confirmed subscriber (publish-time registration can
				// have been skipped when ctx.cron was unavailable).
				await ensureCampaignCron(ctx);
				ctx.log.info(`newsletter: subscriber ${found.id} confirmed`);
				return { ok: true };
			},
		},

		unsubscribe: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { token?: unknown };
				const token = typeof input?.token === "string" ? input.token.trim() : "";
				const found = await findByToken(ctx, token);
				if (found) {
					await subscribers(ctx).delete(found.id);
					ctx.log.info(`newsletter: subscriber ${found.id} unsubscribed`);
				}
				return { ok: true };
			},
		},

		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;
				void interaction;
				// Self-heal: opening the admin page (re)registers the dispatch
				// cron, so stuck "pending" campaigns start draining without
				// requiring a new post publish.
				await ensureCampaignCron(ctx);
				return adminBlocks(ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
