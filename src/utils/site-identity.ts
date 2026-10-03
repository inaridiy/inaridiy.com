/** Resolved media reference from getSiteSettings() */
interface MediaReference {
	mediaId: string;
	alt?: string;
	url?: string;
}

interface BlogSiteIdentitySettings {
	title?: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
}

// The live admin title + the seed's tagline, duplicated as code fallbacks —
// used when the admin settings are unset or blanked (an empty tagline in
// prod is how the home page lost its meta description).
const DEFAULT_SITE_TITLE = "inari's DIY";
const DEFAULT_SITE_TAGLINE = "Web と暗号とものづくりの記録";

/**
 * Admin settings can hold an EMPTY STRING (?? alone lets it through), which
 * cascades into an empty <meta name="description"> being dropped entirely —
 * Lighthouse "Document does not have a meta description" on the home page.
 */
function nonEmpty(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function resolveBlogSiteIdentity(settings?: BlogSiteIdentitySettings) {
	return {
		siteTitle: nonEmpty(settings?.title) ?? DEFAULT_SITE_TITLE,
		siteTagline: nonEmpty(settings?.tagline) ?? DEFAULT_SITE_TAGLINE,
		siteLogo: settings?.logo?.url ? settings.logo : null,
	};
}
