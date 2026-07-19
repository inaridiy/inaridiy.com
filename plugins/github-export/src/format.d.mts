export interface MarkdownEntry {
	slug: string;
	status: string;
	fields: Record<string, string>;
	body: string;
}

export interface CollectionFormat {
	dir: string;
	fields: string[];
	body: string | null;
}

export declare const COLLECTIONS: Record<string, CollectionFormat>;
export declare function serializeEntry(entry: MarkdownEntry, fieldOrder: string[]): string;
export declare function parseEntry(text: string, fallbackSlug: string): MarkdownEntry;
