import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { decodeSlug, getEmDashEntry } from "emdash";

export const prerender = false;

/**
 * Post likes API. Deliberately rough: one D1 table created lazily, one row
 * per (slug, ip_hash), capped at MAX_LIKES per IP per post forever.
 *
 * GET  /api/likes/[slug]  -> { total, mine }
 * POST /api/likes/[slug]  -> increments (clamped), returns { total, mine }
 *
 * Every response — including errors — sets `Cache-Control: no-store`:
 * without an explicit header the Workers Cache in front of this Worker
 * would heuristically cache the response (~2h).
 */

const MAX_LIKES = 5;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

// Lazy one-time table creation, memoized per isolate. Reset on failure so a
// transient D1 error does not poison the isolate forever.
let tableReady: Promise<unknown> | null = null;
function ensureTable(db: D1Database): Promise<unknown> {
	tableReady ??= db
		.prepare(
			`CREATE TABLE IF NOT EXISTS post_likes (
				slug TEXT NOT NULL,
				ip_hash TEXT NOT NULL,
				count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (slug, ip_hash)
			)`,
		)
		.run()
		.catch((error) => {
			tableReady = null;
			throw error;
		});
	return tableReady;
}

function clientIp(request: Request): string {
	return (
		request.headers.get("CF-Connecting-IP") ||
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"local"
	);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validates the slug shape and that a published post actually exists. */
async function resolveSlug(rawParam: string | undefined): Promise<string | null> {
	const slug = decodeSlug(rawParam);
	if (!slug || !SLUG_RE.test(slug)) return null;
	// Same KV-cached query the post page uses — cheap, and keeps junk slugs
	// from ever creating rows.
	const { entry } = await getEmDashEntry("posts", slug);
	return entry ? slug : null;
}

async function readCounts(
	db: D1Database,
	slug: string,
	ipHash: string,
): Promise<{ total: number; mine: number }> {
	const row = await db
		.prepare(
			`SELECT
				COALESCE(SUM(count), 0) AS total,
				COALESCE(SUM(CASE WHEN ip_hash = ?2 THEN count END), 0) AS mine
			FROM post_likes WHERE slug = ?1`,
		)
		.bind(slug, ipHash)
		.first<{ total: number; mine: number }>();
	return { total: row?.total ?? 0, mine: row?.mine ?? 0 };
}

export const GET: APIRoute = async ({ params, request }) => {
	try {
		const db = (env as Partial<Env>).DB;
		if (!db) return json({ error: "unavailable" }, 503);

		const slug = await resolveSlug(params.slug);
		if (!slug) return json({ error: "not_found" }, 404);

		await ensureTable(db);
		const ipHash = await sha256Hex(`${clientIp(request)}:${slug}`);
		return json(await readCounts(db, slug, ipHash));
	} catch (error) {
		console.error({
			event: "likes_get_failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return json({ error: "internal" }, 500);
	}
};

export const POST: APIRoute = async ({ params, request }) => {
	try {
		const db = (env as Partial<Env>).DB;
		if (!db) return json({ error: "unavailable" }, 503);

		const slug = await resolveSlug(params.slug);
		if (!slug) return json({ error: "not_found" }, 404);

		const ipHash = await sha256Hex(`${clientIp(request)}:${slug}`);

		const limiter = (env as Partial<Env>).LIKES_RATE_LIMITER;
		if (limiter) {
			try {
				const result = await limiter.limit({ key: `likes:${ipHash}` });
				if (!result.success) return json({ error: "rate_limited" }, 429);
			} catch (error) {
				// Limiter outage should not take likes down — the 5-per-IP cap
				// in D1 still bounds abuse.
				console.error({
					event: "likes_rate_limit_failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		await ensureTable(db);
		await db
			.prepare(
				`INSERT INTO post_likes (slug, ip_hash, count) VALUES (?1, ?2, 1)
				ON CONFLICT(slug, ip_hash) DO UPDATE SET count = MIN(count + 1, ?3)`,
			)
			.bind(slug, ipHash, MAX_LIKES)
			.run();
		return json(await readCounts(db, slug, ipHash));
	} catch (error) {
		console.error({
			event: "likes_post_failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return json({ error: "internal" }, 500);
	}
};
