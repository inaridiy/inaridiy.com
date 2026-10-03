export type ContentLanguage = "ja" | "en";
export type SearchFieldKind = "text" | "portableText";

export interface SearchBodyField {
	field: string;
	kind: SearchFieldKind;
	fallbackField?: string;
	label?: string;
}

export interface SearchProjection {
	lang: ContentLanguage;
	keySuffix: "" | ".en";
	titleField: string;
	titleFallbackField?: string;
	availabilityFields?: readonly string[];
	body: readonly SearchBodyField[];
	url(slug: string): string;
}

export interface ContentCollectionContract {
	table: string;
	translation: {
		strings: Readonly<Record<string, string>>;
		portableText: Readonly<Record<string, string>>;
	};
	search: readonly SearchProjection[];
}

export const CONTENT_CONTRACT = {
	posts: {
		table: "ec_posts",
		translation: {
			strings: { title: "title_en", excerpt: "excerpt_en" },
			portableText: { content: "content_en" },
		},
		search: [
			{
				lang: "ja",
				keySuffix: "",
				titleField: "title",
				body: [
					{ field: "excerpt", kind: "text" },
					{ field: "content", kind: "portableText" },
				],
				url: (slug) => `/posts/${slug}`,
			},
			{
				lang: "en",
				keySuffix: ".en",
				titleField: "title_en",
				titleFallbackField: "title",
				availabilityFields: ["title_en", "excerpt_en", "content_en"],
				body: [
					{ field: "excerpt_en", fallbackField: "excerpt", kind: "text" },
					{ field: "content_en", fallbackField: "content", kind: "portableText" },
				],
				url: (slug) => `/en/posts/${slug}`,
			},
		],
	},
	pages: {
		table: "ec_pages",
		translation: {
			strings: { title: "title_en" },
			portableText: { content: "content_en" },
		},
		search: [
			{
				lang: "ja",
				keySuffix: "",
				titleField: "title",
				body: [{ field: "content", kind: "portableText" }],
				url: (slug) => (slug === "about" ? "/about" : `/pages/${slug}`),
			},
			{
				lang: "en",
				keySuffix: ".en",
				titleField: "title_en",
				titleFallbackField: "title",
				availabilityFields: ["title_en", "content_en"],
				body: [{ field: "content_en", fallbackField: "content", kind: "portableText" }],
				url: (slug) => (slug === "about" ? "/en/about" : `/en/pages/${slug}`),
			},
		],
	},
	activities: {
		table: "ec_activities",
		translation: {
			strings: { title: "title_en", description: "description_en" },
			portableText: {},
		},
		search: [
			{
				lang: "ja",
				keySuffix: "",
				titleField: "title",
				body: [
					{ field: "date", kind: "text", label: "Date" },
					{ field: "kind", kind: "text", label: "Kind" },
					{ field: "url", kind: "text", label: "Link" },
					{ field: "description", kind: "text" },
				],
				url: () => "/activities",
			},
			{
				lang: "en",
				keySuffix: ".en",
				titleField: "title_en",
				titleFallbackField: "title",
				availabilityFields: ["title_en", "description_en"],
				body: [
					{ field: "date", kind: "text", label: "Date" },
					{ field: "kind", kind: "text", label: "Kind" },
					{ field: "url", kind: "text", label: "Link" },
					{ field: "description_en", fallbackField: "description", kind: "text" },
				],
				url: () => "/en/activities",
			},
		],
	},
} as const satisfies Record<string, ContentCollectionContract>;

export type ContentCollection = keyof typeof CONTENT_CONTRACT;

export const CONTENT_COLLECTIONS = Object.keys(CONTENT_CONTRACT) as ContentCollection[];

export function isContentCollection(value: string): value is ContentCollection {
	return Object.hasOwn(CONTENT_CONTRACT, value);
}

export function getContentContract(
	collection: ContentCollection,
): ContentCollectionContract {
	return CONTENT_CONTRACT[collection];
}

export function getContentQueryColumns(collection: ContentCollection): string[] {
	const contract = getContentContract(collection);
	const fields = new Set<string>(["id", "slug"]);
	for (const [source, target] of Object.entries(contract.translation.strings)) {
		fields.add(source);
		fields.add(target);
	}
	for (const [source, target] of Object.entries(contract.translation.portableText)) {
		fields.add(source);
		fields.add(target);
	}
	for (const projection of contract.search) {
		fields.add(projection.titleField);
		if (projection.titleFallbackField) fields.add(projection.titleFallbackField);
		for (const availabilityField of projection.availabilityFields ?? []) {
			fields.add(availabilityField);
		}
		for (const bodyField of projection.body) {
			fields.add(bodyField.field);
			if (bodyField.fallbackField) fields.add(bodyField.fallbackField);
		}
	}
	return [...fields];
}
