export interface FieldLike {
	slug: string;
	type: string;
	sortOrder?: number;
}

export interface CollectionFormat {
	/** Scalar fields stored as frontmatter, in order. */
	fields: string[];
	/** Portable Text field stored as the Markdown body, if any. */
	body: string | null;
}

export interface MarkdownEntry {
	cmsId?: string;
	slug: string;
	status: string;
	fields: Record<string, unknown>;
	body: string;
}

export declare function collectionFormat(fields: FieldLike[]): CollectionFormat;
export declare function isSyncedEntry(item: { id: string; translationGroup?: string | null }): boolean;
export declare function entryPath(dir: string, collection: string, slug: string): string;
export declare function serializeEntry(entry: MarkdownEntry, format: CollectionFormat): string;
export declare function parseEntry(text: string, fallbackSlug: string): MarkdownEntry;
export declare function pickFields(
	data: Record<string, unknown>,
	format: CollectionFormat,
): Record<string, unknown>;
