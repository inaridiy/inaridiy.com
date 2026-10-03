import {
	LOCALES,
	localizedPath,
	SOURCE_LOCALE,
	type ContentCollection,
	type ContentLocale,
} from "@inaridiy/content-contract";
import { getEmDashEntry, getTranslations } from "emdash";

export interface Alternate {
	hreflang: string;
	path: string;
}

export interface PublishedTranslation {
	slug: string;
	path: string;
}

export type PublishedTranslations = Partial<Record<ContentLocale, PublishedTranslation>>;

/**
 * An entry's published translations (itself included), keyed by locale.
 * Slugs are per locale — the English entry's slug comes from its own
 * title — so links between languages always go through the translation group.
 */
export async function getPublishedTranslations(
	collection: ContentCollection,
	entryId: string,
): Promise<PublishedTranslations> {
	const { translations } = await getTranslations(collection, entryId);
	const published: PublishedTranslations = {};
	for (const translation of translations) {
		const locale = LOCALES.find((candidate) => candidate === translation.locale);
		if (!locale || translation.status !== "published" || !translation.slug) continue;
		published[locale] = {
			slug: translation.slug,
			path: localizedPath(collection, translation.slug, locale),
		};
	}
	return published;
}

/** hreflang alternates (plus x-default → Japanese) for an entry's translations. */
export function alternatesFor(translations: PublishedTranslations): Alternate[] {
	const alternates: Alternate[] = LOCALES.flatMap((locale) => {
		const translation = translations[locale];
		return translation ? [{ hreflang: locale, path: translation.path }] : [];
	});
	const fallback = translations[SOURCE_LOCALE];
	return fallback
		? [...alternates, { hreflang: "x-default", path: fallback.path }]
		: alternates;
}

/** Alternates for fixed, non-entry pages that exist in both languages. */
export function staticAlternates(path: string): Alternate[] {
	return [
		{ hreflang: "ja", path },
		{ hreflang: "en", path: path === "/" ? "/en" : `/en${path}` },
		{ hreflang: "x-default", path },
	];
}

/**
 * Resolve the entry behind a fixed route (e.g. /en/about, keyed by the
 * Japanese slug) in the requested locale through the source entry's
 * translation group. Falls back to the source entry when no published
 * translation exists. Both entries' cache hints must be applied.
 */
export async function getLocalizedEntryBySourceSlug<C extends ContentCollection>(
	collection: C,
	sourceSlug: string,
	locale: ContentLocale,
) {
	const source = await getEmDashEntry(collection, sourceSlug, { locale: SOURCE_LOCALE });
	const translations = source.entry
		? await getPublishedTranslations(collection, source.entry.data.id)
		: {};
	const target = locale === SOURCE_LOCALE ? undefined : translations[locale];
	const localized = target
		? await getEmDashEntry(collection, target.slug, { locale })
		: undefined;
	const useLocalized = Boolean(localized?.entry && !localized.fallbackLocale);
	return {
		entry: useLocalized ? localized!.entry : source.entry,
		isTranslated: locale === SOURCE_LOCALE || useLocalized,
		translations,
		cacheHints: [source.cacheHint, ...(localized ? [localized.cacheHint] : [])],
	};
}
