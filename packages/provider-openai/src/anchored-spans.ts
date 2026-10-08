import { AnchoredSpanSources, type AnchoredAnswerSpan } from '@ainyc/canonry-contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface UrlCitation {
  start: number
  end: number
  url: string
}

/**
 * The answer prose each `url_citation` annotation ties to its source, for
 * competitor auto-alias detection (contracts `competitor-auto-aliases.ts`).
 *
 * An annotation's `[start_index, end_index)` span is the citation CHIP itself
 * (` ([host](url))`), whose label is a host, never a business name. The name
 * the chip cites sits BEFORE it on the same line, so the window runs from the
 * line start (or the previous annotation's end, whichever is later) up to
 * `start_index`. Offsets are UTF-16 code units, which is what `String.slice`
 * counts. Reads the stored response only; never resolves a URL.
 */
export function extractAnchoredSpans(rawResponse: Record<string, unknown>): AnchoredAnswerSpan[] {
  const spans: AnchoredAnswerSpan[] = []
  const output = Array.isArray(rawResponse.output) ? rawResponse.output : []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue
      const text = part.text
      const citations: UrlCitation[] = (Array.isArray(part.annotations) ? part.annotations : [])
        .flatMap((annotation): UrlCitation[] => {
          if (!isRecord(annotation) || annotation.type !== 'url_citation' || typeof annotation.url !== 'string') return []
          const start = annotation.start_index
          const end = annotation.end_index
          if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) return []
          if (start < 0 || end < start || end > text.length) return []
          return [{ start, end, url: annotation.url }]
        })
        .sort((a, b) => a.start - b.start)
      let previousEnd = 0
      for (const citation of citations) {
        const lineStart = citation.start === 0 ? 0 : text.lastIndexOf('\n', citation.start - 1) + 1
        const from = Math.max(lineStart, previousEnd)
        if (citation.start > from) {
          spans.push({ text: text.slice(from, citation.start), source: citation.url, kind: 'window', via: AnchoredSpanSources['openai-annotation'] })
        }
        previousEnd = Math.max(previousEnd, citation.end)
      }
    }
  }
  return spans
}
