import { AnchoredSpanSources, type AnchoredAnswerSpan } from "@ainyc/canonry-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The tail of an uncited lead-in block: the last line that holds text, plus
 * whatever follows it, exactly as the answer text joins it to the next block.
 */
function leadIn(text: string): string {
  const end = text.trimEnd().length;
  if (end === 0) return "";
  return text.slice(text.lastIndexOf("\n", end - 1) + 1);
}

/**
 * The answer prose each `web_search_result_location` citation ties to its
 * source, for competitor auto-alias detection (contracts
 * `competitor-auto-aliases.ts`).
 *
 * Claude splits a cited claim into its own text block carrying the
 * citations; the business name usually leads the claim in the PRECEDING
 * uncited block (`\n- **Name** - `). The window is that lead-in's last line
 * plus the cited block's text, once per distinct cited URL. `cited_text` and
 * `title` are the source page's own words, not the answer's, and are never
 * read. Reads the stored response only; never resolves a URL.
 */
export function extractAnchoredSpans(rawResponse: Record<string, unknown>): AnchoredAnswerSpan[] {
  const spans: AnchoredAnswerSpan[] = [];
  const content = Array.isArray(rawResponse.content) ? rawResponse.content : [];
  let previousUncited: string | null = null;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const urls = new Set<string>();
    for (const citation of Array.isArray(block.citations) ? block.citations : []) {
      if (isRecord(citation) && citation.type === "web_search_result_location" && typeof citation.url === "string") {
        urls.add(citation.url);
      }
    }
    if (urls.size === 0) {
      previousUncited = block.text;
      continue;
    }
    const window = (previousUncited === null ? "" : leadIn(previousUncited)) + block.text;
    for (const url of urls) {
      spans.push({ text: window, source: url, kind: "window", via: AnchoredSpanSources["claude-citation"] });
    }
    previousUncited = null;
  }
  return spans;
}
