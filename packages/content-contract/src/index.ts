/**
 * Shared content contract for the site, the translator plugin and the
 * Markdown sync tooling.
 *
 * Translations use EmDash's native i18n: every locale is its own entry in a
 * shared translation group. Japanese is the source locale; the translator
 * plugin creates and updates the English entry of each group. Fields marked
 * `translatable: false` in the schema (activity date/kind/url, the post OG
 * image) are synced across the group by EmDash itself and are not listed here.
 */

export const SOURCE_LOCALE = "ja";
export const TARGET_LOCALE = "en";
export const LOCALES = [SOURCE_LOCALE, TARGET_LOCALE] as const;
export type ContentLocale = (typeof LOCALES)[number];

export interface ContentCollectionContract {
	/** Translatable plain-text fields, translated as whole strings. */
	strings: readonly string[];
	/** Translatable Portable Text fields, translated span by span. */
	portableText: readonly string[];
	/** Public path of an entry, without the locale prefix. */
	path(slug: string): string;
}

export const CONTENT_CONTRACT = {
	posts: {
		strings: ["title", "excerpt"],
		portableText: ["content"],
		path: (slug) => `/posts/${slug}`,
	},
	pages: {
		strings: ["title"],
		portableText: ["content"],
		path: (slug) => (slug === "about" ? "/about" : `/pages/${slug}`),
	},
	activities: {
		strings: ["title", "description"],
		portableText: [],
		path: () => "/activities",
	},
} as const satisfies Record<string, ContentCollectionContract>;

export type ContentCollection = keyof typeof CONTENT_CONTRACT;

export const CONTENT_COLLECTIONS = Object.keys(CONTENT_CONTRACT) as ContentCollection[];

export function isContentCollection(value: string): value is ContentCollection {
	return Object.hasOwn(CONTENT_CONTRACT, value);
}

export function getContentContract(collection: ContentCollection): ContentCollectionContract {
	return CONTENT_CONTRACT[collection];
}

/** Locale prefix for public URLs: the source locale is unprefixed. */
export function localePrefix(locale: string | null | undefined): string {
	return locale && locale !== SOURCE_LOCALE ? `/${locale}` : "";
}

export function localizedPath(
	collection: ContentCollection,
	slug: string,
	locale: string | null | undefined,
): string {
	return `${localePrefix(locale)}${getContentContract(collection).path(slug)}`;
}
