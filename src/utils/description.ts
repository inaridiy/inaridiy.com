import type { PortableTextBlock } from "emdash";
import { extractText } from "./reading-time";

/** Roughly what search results display for Japanese pages. */
const MAX_DESCRIPTION_LENGTH = 120;

/**
 * Meta description derived from Portable Text body, for entries without an
 * excerpt (EmDash's getSeoMeta only falls back seo.description → excerpt and
 * otherwise returns null, which drops the <meta name="description"> tag).
 */
export function descriptionFromContent(
	content: PortableTextBlock[] | undefined,
	fallback: string,
): string {
	const text = extractText(content).replace(/\s+/g, " ").trim();
	if (!text) return fallback;
	if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
	return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}
