import {
  AnchoredSpanSources,
  hostOf,
  registrableDomain,
  VERTEX_AI_SEARCH_PROXY_DOMAIN,
  type AnchoredAnswerSpan,
} from '@ainyc/canonry-contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A grounding chunk's site. `web.uri` is an opaque Vertex AI Search redirect
 * that is never resolved (no network), so the site comes from `web.title`,
 * which holds the source domain; a chunk whose `uri` is a real page URL uses
 * that instead.
 */
function chunkSource(chunk: unknown): string | null {
  if (!isRecord(chunk) || !isRecord(chunk.web)) return null
  const uri = typeof chunk.web.uri === 'string' ? chunk.web.uri : ''
  const uriHost = hostOf(uri)
  if (uriHost && uriHost !== VERTEX_AI_SEARCH_PROXY_DOMAIN && registrableDomain(uriHost)) return uri
  const title = typeof chunk.web.title === 'string' ? chunk.web.title.trim() : ''
  return title && registrableDomain(title) ? title : null
}

/**
 * The answer prose each grounding support ties to its chunks' sites, for
 * competitor auto-alias detection (contracts `competitor-auto-aliases.ts`).
 *
 * The window is `segment.text`, which is the supported stretch of the answer
 * itself (usually one list item). Its `startIndex` / `endIndex` are UTF-8 byte
 * offsets and `startIndex` is omitted when 0, so they are never used to slice.
 * A support that cites chunks from several sites yields one span per site.
 * Rows stored before grounding supports existed yield none. Reads the stored
 * response only.
 */
export function extractAnchoredSpans(rawResponse: Record<string, unknown>): AnchoredAnswerSpan[] {
  const candidates: unknown[] = Array.isArray(rawResponse.candidates) ? rawResponse.candidates : []
  const candidate = candidates[0]
  if (!isRecord(candidate) || !isRecord(candidate.groundingMetadata)) return []
  const metadata = candidate.groundingMetadata
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []
  const spans: AnchoredAnswerSpan[] = []
  for (const support of Array.isArray(metadata.groundingSupports) ? metadata.groundingSupports : []) {
    if (!isRecord(support) || !isRecord(support.segment)) continue
    const text = support.segment.text
    if (typeof text !== 'string' || !text.trim()) continue
    const sources = new Set<string>()
    for (const index of Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : []) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= chunks.length) continue
      const source = chunkSource(chunks[index])
      if (source) sources.add(source)
    }
    for (const source of sources) {
      spans.push({ text, source, kind: 'window', via: AnchoredSpanSources['gemini-support'] })
    }
  }
  return spans
}
