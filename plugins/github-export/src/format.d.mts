export interface MarkdownEntry {
	slug: string;
	status: string;
	fields: Record<string, string>;
	body: string;
}

export declare const FRONT_FIELDS: string[];
export declare function serializeEntry(entry: MarkdownEntry): string;
export declare function parseEntry(text: string, fallbackSlug: string): MarkdownEntry;
