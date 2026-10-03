import type { ContentLocale } from "@inaridiy/content-contract";
import { getEmDashCollection } from "emdash";

/** Fetch the complete activity log while preserving every page's cache tag. */
export async function getAllPublishedActivities(locale: ContentLocale) {
	let page = await getEmDashCollection("activities", {
		locale,
		status: "published",
		orderBy: { date: "desc" },
		limit: 100,
	});
	const entries = [...page.entries];
	const cacheHints = [page.cacheHint];
	while (page.nextCursor) {
		page = await getEmDashCollection("activities", {
			locale,
			status: "published",
			orderBy: { date: "desc" },
			limit: 100,
			cursor: page.nextCursor,
		});
		entries.push(...page.entries);
		cacheHints.push(page.cacheHint);
	}
	return { entries, cacheHints };
}
