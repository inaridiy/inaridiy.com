import { env } from "cloudflare:workers";
import {
	POST as aiSearchEndpoint,
	getActiveAISearchConfig,
	unpackTitleDescription,
} from "@emdash-cms/cloudflare/plugins/ai-search";
import { isContentCollection, localizedPath } from "@inaridiy/content-contract";
import type { APIContext } from "astro";

/**
 * /search on top of EmDash's aiSearch() plugin (astro.config.mjs).
 *
 * Keyword mode goes through the plugin's own search endpoint handler, so the
 * admin-configured synonyms, the locale filter (with default-locale
 * fallback) and the "plugin active" check stay EmDash's. AI mode asks the
 * same AI Search instance for an answer, restricted to the visitor's locale.
 */

export interface SearchResultRow {
	url: string;
	title: string;
	snippet?: string;
}

const MAX_RESULTS = 12;
const MAX_AI_SOURCES = 8;

/**
 * The plugin renders result URLs from `/{locale}/{collection}/{slug}`
 * templates; map them onto the site's routes (unprefixed Japanese, `/about`).
 */
function siteUrl(templated: string): string {
	const match = /^\/([a-z-]+)\/([a-z]+)(?:\/(.*))?$/i.exec(templated);
	if (!match) return templated;
	const [, locale, collection, slug = ""] = match;
	return isContentCollection(collection)
		? localizedPath(collection, decodeURIComponent(slug), locale)
		: templated;
}

function dedupe(rows: SearchResultRow[]): SearchResultRow[] {
	const seen = new Set<string>();
	return rows.filter((row) => !seen.has(row.url) && seen.add(row.url));
}

export async function keywordSearch(query: string, locale: string): Promise<SearchResultRow[]> {
	const request = new Request("https://internal.invalid/api/ai-search", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			messages: [{ role: "user", content: query }],
			locale,
			ai_search_options: { retrieval: { max_num_results: MAX_RESULTS } },
		}),
	});
	const response = await aiSearchEndpoint({ request } as APIContext);
	const body = (await response.json()) as {
		success: boolean;
		error?: string;
		result?: {
			chunks: Array<{ item: { key: string; metadata: { title: string; description: string } } }>;
		};
	};
	if (!response.ok || !body.success || !body.result) {
		throw new Error(body.error ?? `AI Search endpoint returned HTTP ${response.status}`);
	}
	return dedupe(
		body.result.chunks.map(({ item }) => ({
			url: siteUrl(item.key),
			title: item.metadata.title,
			snippet: item.metadata.description || undefined,
		})),
	);
}

export async function aiAnswer(
	query: string,
	locale: string,
): Promise<{ answer: string | null; sources: SearchResultRow[] }> {
	const namespace = (env as Partial<Env>).AI_SEARCH;
	if (!namespace) throw new Error("AI_SEARCH binding is not available");
	const instance = namespace.get(getActiveAISearchConfig().instanceName ?? "emdash-content");
	const result = await instance.chatCompletions({
		messages: [{ role: "user", content: query }],
		ai_search_options: {
			retrieval: {
				max_num_results: MAX_AI_SOURCES,
				filters: {
					locale: { $eq: locale },
					visible_after: { $lte: Math.floor(Date.now() / 1000) },
				},
			},
		},
	});
	const sources = (result.chunks ?? []).flatMap((chunk) => {
		const metadata = chunk.item?.metadata ?? {};
		const [collection = ""] = (chunk.item?.key ?? "").split("/");
		const slug = typeof metadata.slug === "string" ? metadata.slug : "";
		if (!isContentCollection(collection) || !slug) return [];
		const { title, description } = unpackTitleDescription(
			typeof metadata.title_desc === "string" ? metadata.title_desc : "",
		);
		return [
			{
				url: localizedPath(collection, slug, locale),
				title: title || slug,
				snippet: description || undefined,
			},
		];
	});
	return { answer: result.choices?.[0]?.message?.content ?? null, sources: dedupe(sources) };
}
