import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import type { StorageCollection } from "emdash";

/**
 * Newsletter plugin (runtime). See ./index.ts for the overview.
 *
 * Flow:
 *   subscribe (public POST {email})  -> pending + confirm email
 *   confirm   (public POST {token})  -> status confirmed
 *   unsubscribe (public POST {token}) -> record deleted
 *   content:afterPublish (posts)     -> notify confirmed subscribers ONCE
 *                                       per post (KV state:notified:<id>)
 *
 * Abuse guards: email format validation, resend throttle (one confirm
 * email per address per 24h), silent success responses (no address
 * enumeration).
 */

const SITE_URL = "https://inaridiy.com";
const SITE_NAME = "inaridiy.com";
const RESEND_THROTTLE_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Subscriber {
	email: string;
	status: "pending" | "confirmed";
	token: string;
	createdAt: string;
	confirmSentAt?: string;
	confirmedAt?: string;
}

function subscribers(ctx: PluginContext): StorageCollection<Subscriber> {
	return ctx.storage.subscribers as StorageCollection<Subscriber>;
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

async function sendConfirmEmail(ctx: PluginContext, subscriber: Subscriber): Promise<void> {
	await ctx.email!.send({
		to: subscriber.email,
		subject: `${SITE_NAME} の購読確認`,
		text: [
			`${SITE_NAME} の新着記事メールの購読手続きです。`,
			"",
			"以下のリンクを開くと購読が完了します:",
			`${SITE_URL}/newsletter/confirm?token=${subscriber.token}`,
			"",
			"心当たりがない場合はこのメールを無視してください。",
		].join("\n"),
	});
}

/* ------------------------------------------------------------------ */

interface ContentEvent {
	content: Record<string, unknown>;
	collection: string;
}

async function notifySubscribers(event: ContentEvent, ctx: PluginContext): Promise<void> {
	if (event.collection !== "posts") return;
	const id = typeof event.content.id === "string" ? event.content.id : null;
	if (!id) return;

	// Notify exactly once per post, ever (edits/re-publishes stay silent)
	const notifiedKey = `state:notified:${id}`;
	if (await ctx.kv.get<boolean>(notifiedKey)) return;

	const item = await ctx.content!.get("posts", id);
	if (!item || item.status !== "published" || !item.slug) return;

	if (!ctx.email) {
		ctx.log.warn("newsletter: email pipeline unavailable (no provider selected)");
		return;
	}

	const title = typeof item.data.title === "string" ? item.data.title : item.slug;
	const excerpt = typeof item.data.excerpt === "string" ? item.data.excerpt : "";
	const postUrl = `${SITE_URL}/posts/${item.slug}`;

	let sent = 0;
	let failed = 0;
	let cursor: string | undefined;
	do {
		const page = await subscribers(ctx).query({
			where: { status: "confirmed" },
			limit: 100,
			cursor,
		});
		for (const { data: subscriber } of page.items) {
			try {
				await ctx.email.send({
					to: subscriber.email,
					subject: `${title} — ${SITE_NAME}`,
					text: [
						title,
						"",
						...(excerpt ? [excerpt, ""] : []),
						`読む: ${postUrl}`,
						"",
						"--",
						`配信停止: ${SITE_URL}/newsletter/unsubscribe?token=${subscriber.token}`,
					].join("\n"),
				});
				sent++;
			} catch (error) {
				failed++;
				ctx.log.error(
					`newsletter: send failed for ${subscriber.email}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		cursor = page.cursor ?? undefined;
	} while (cursor);

	await ctx.kv.set(notifiedKey, true);
	await ctx.kv.set("state:last", {
		at: new Date().toISOString(),
		post: item.slug,
		sent,
		failed,
	});
	if (sent > 0 || failed > 0) {
		ctx.log.info(`newsletter: notified ${sent} subscriber(s) for ${item.slug} (${failed} failed)`);
	}
}

/* ------------------------------------------------------------------ */
/* Block Kit admin page                                                */
/* ------------------------------------------------------------------ */

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

async function adminBlocks(ctx: PluginContext) {
	const store = subscribers(ctx);
	const confirmed = await store.count({ status: "confirmed" });
	const pending = await store.count({ status: "pending" });
	const recent = await store.query({ orderBy: { createdAt: "desc" }, limit: 50 });
	const last = await ctx.kv.get<Record<string, unknown>>("state:last");

	return {
		blocks: [
			{ type: "header", text: "Newsletter" },
			{
				type: "stats",
				stats: [
					{ label: "Confirmed", value: String(confirmed) },
					{ label: "Pending", value: String(pending) },
				],
			},
			{
				type: "fields",
				fields: [{ label: "Last send", value: last ? JSON.stringify(last) : "never" }],
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
				text: "Subscribers sign up via the site footer (double opt-in). New-post emails go out once per post on first publish, through the email-sender transport.",
			},
		],
	};
}

/* ------------------------------------------------------------------ */

export default {
	hooks: {
		"content:afterPublish": {
			priority: 400,
			timeout: 120000,
			errorPolicy: "continue",
			handler: async (event: ContentEvent, ctx: PluginContext) => {
				await notifySubscribers(event, ctx);
			},
		},
	},

	routes: {
		subscribe: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { email?: unknown };
				const email = String(input?.email ?? "")
					.trim()
					.toLowerCase();
				if (!EMAIL_RE.test(email) || email.length > 254) {
					return { ok: false, error: "invalid_email" };
				}
				if (!ctx.email) {
					ctx.log.warn("newsletter: subscribe attempted but email pipeline unavailable");
					return { ok: false, error: "unavailable" };
				}

				const existing = await findByEmail(ctx, email);
				if (existing?.data.status === "confirmed") {
					// Silent success — do not leak which addresses are subscribed
					return { ok: true };
				}
				const now = new Date().toISOString();
				if (
					existing?.data.confirmSentAt &&
					Date.now() - Date.parse(existing.data.confirmSentAt) < RESEND_THROTTLE_MS
				) {
					return { ok: true };
				}

				const record: Subscriber = existing?.data ?? {
					email,
					status: "pending",
					token: crypto.randomUUID(),
					createdAt: now,
				};
				const recordId = existing ? existing.id : crypto.randomUUID();
				try {
					await sendConfirmEmail(ctx, record);
				} catch (error) {
					ctx.log.error(
						`newsletter: confirm email failed for ${email}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					return { ok: false, error: "send_failed" };
				}
				// Persist only after the send succeeded so a failed send
				// doesn't start the 24h resend throttle
				record.confirmSentAt = now;
				await subscribers(ctx).put(recordId, record);
				ctx.log.info(`newsletter: confirm email sent to ${email}`);
				return { ok: true };
			},
		},

		confirm: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { token?: unknown };
				const found = await findByToken(ctx, String(input?.token ?? "").trim());
				if (!found) return { ok: false };
				await subscribers(ctx).put(found.id, {
					...found.data,
					status: "confirmed",
					confirmedAt: new Date().toISOString(),
				});
				ctx.log.info(`newsletter: confirmed ${found.data.email}`);
				return { ok: true };
			},
		},

		unsubscribe: {
			public: true,
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const input = routeCtx.input as { token?: unknown };
				const found = await findByToken(ctx, String(input?.token ?? "").trim());
				if (found) {
					await subscribers(ctx).delete(found.id);
					ctx.log.info(`newsletter: unsubscribed ${found.data.email}`);
				}
				// Always succeed — the link may be clicked twice
				return { ok: true };
			},
		},

		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;
				void interaction;
				return adminBlocks(ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
