import type { PortableTextBlock } from "emdash";
import { extractText } from "./reading-time";

/** Cheap check for KaTeX delimiters so the katex bundle only loads on
 * pages that actually contain math. */
export function hasMath(content: PortableTextBlock[] | undefined): boolean {
	if (!content) return false;
	const text = extractText(content);
	return /\$\$|\\\(|\\\[|\$[^\s$][^$]*\$/.test(text);
}
