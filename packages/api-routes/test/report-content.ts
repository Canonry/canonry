/**
 * The content of a rendered report section: the numbers, cells, badges and
 * links a reader actually sees, normalized so the HTML renderer and the SPA
 * produce the SAME list for the same DTO and audience.
 *
 * The outline in `report-outline.ts` records the section scaffold — ids,
 * eyebrows, titles, h3s, table HEADERS, tile LABELS, empty states and notes.
 * Everything a reader reads BETWEEN those was unguarded: tile values and
 * subtitles, table body cells, badges and their tone, delta tones, list and
 * step rows, link targets, and details summaries could differ between the two
 * surfaces with every parity test green. This module reads them.
 *
 * ## Why the two surfaces can be compared at all
 *
 * They nest the same words differently. The HTML report writes
 * `<div class="subtitle">234 verified · <span class="tone-positive">Up 104%</span></div>`;
 * the SPA writes the same line as three nested `<span>`s from `joinReportParts`.
 * A reader sees one line either way. So the normalizer is deliberately
 * insensitive to nesting:
 *
 * - **One space per element boundary.** Entering and leaving any element
 *   contributes a single space; adjacent text nodes contribute none. A JSX
 *   split like `{n}%` therefore reads `65%`, exactly as the HTML's `65%` does,
 *   while `<strong>20%</strong> of citations` reads `20% of citations` on both.
 *   This is also what makes the two whitespace conventions agree: the HTML
 *   renderer's template literals indent with newlines between inline elements
 *   and JSX drops that whitespace entirely, and after this rule neither matters.
 * - **Runs of copy are not split by nesting.** Text outside any unit
 *   accumulates into one entry, flushed when a unit starts. Whether a hero is
 *   four sibling divs or four nested spans, it reads as one run.
 *
 * ## Units
 *
 * A unit breaks the run around it and is read whole:
 *
 * - `{ tile }`: one metric tile — label, value, and the line under it.
 * - `{ row }`: one table BODY row, cell by cell (headers are the outline's
 *   `table` item, so they are not repeated here).
 * - `{ item }`: one list row — an `li` on either surface, or the HTML report's
 *   `.step`, which the SPA renders as an `li`.
 * - `{ summary }`: a `details` summary.
 * - `{ text }`: a heading, a note, an empty state, or a flushed run of copy.
 *
 * ## Tone
 *
 * Each surface names tone in its own vocabulary — `tone-positive` in the HTML
 * report, `text-positive-400` / `insight-card-negative` and the ToneBadge
 * variants in the SPA. Both map onto one token set, and a toned run is wrapped
 * where it sits: `«positive|Up 104% vs prior 7 days»`. NEUTRAL IS NO TONE. The
 * two surfaces disagree about whether a neutral thing is marked at all — the
 * HTML report's recommended-next-step horizon is a plain `<span>`, the SPA's is
 * a `tone="neutral"` ToneBadge — and that is styling, not content. A real tone
 * change still shows: retoning a badge to neutral DROPS its marker.
 *
 * ## What is excluded, by kind
 *
 * - `svg` and its internals. Both surfaces draw charts, neither draws the same
 *   markup, and in the SPA suite recharts is stubbed out entirely. Bars drawn
 *   as elements (the client summary's provider bars, ShareBars) are NOT svg and
 *   are read, value labels included.
 * - `button`, `input`, `select`, `textarea`, `[role="button"]`: the SPA's
 *   interactive controls — "Mark addressed", the InfoTooltip triggers — which a
 *   downloadable document has no equivalent of. A note whose words live on such
 *   a trigger is still read, through the surface's `overrideText`.
 * - `.sr-only` and `[aria-hidden="true"]`: alternate renderings of something
 *   already read (the SPA's chart data tables), not content of their own.
 */

export type ReportContentTone = 'positive' | 'caution' | 'negative'

export type ReportContentEntry =
  | { text: string }
  | { tile: string }
  | { row: string[] }
  | { item: string }
  | { summary: string }

/** How one surface names the things both surfaces render. */
export interface ReportContentSurface {
  /** The tone this element states, or null for none and for neutral. */
  tone(element: Element): ReportContentTone | null
  /** A metric tile: its label, value and the line under it are one unit. */
  isTile(element: Element): boolean
  /** A list row this surface does not write as an `li`. */
  isListRow(element: Element): boolean
  /** A heading, a note, or an empty state: copy that stands on its own line. */
  isCopyUnit(element: Element): boolean
  /** The words of an element that does not carry them as text, or null. */
  overrideText(element: Element): string | null
}

const SKIP = 'svg, script, style, template, button, input, select, textarea, [role="button"], .sr-only, [aria-hidden="true"]'

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Collapse runs of whitespace the way a reader sees rendered text. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isSkipped(element: Element): boolean {
  return element.matches(SKIP)
}

function isUnit(element: Element, surface: ReportContentSurface): boolean {
  return element.tagName === 'TR'
    || element.tagName === 'SUMMARY'
    || element.tagName === 'LI'
    || surface.isListRow(element)
    || surface.isTile(element)
    || surface.isCopyUnit(element)
}

function containsUnit(element: Element, surface: ReportContentSurface): boolean {
  return Array.from(element.children).some(child => isUnit(child, surface) || containsUnit(child, surface))
}

/**
 * One element read whole: its words in order, with a tone or link marker
 * wrapping whichever run states one.
 */
export function reportContentRunText(element: Element, surface: ReportContentSurface): string {
  if (isSkipped(element)) return ''
  const inner = collapse(readChildren(element, surface))
  if (inner === '') return ''
  const href = element.tagName === 'A' ? element.getAttribute('href') : null
  const tone = surface.tone(element)
  const linked = href ? `«link ${href}|${inner}»` : inner
  return tone ? `«${tone}|${linked}»` : linked
}

function readChildren(element: Element, surface: ReportContentSurface): string {
  let out = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? ''
      continue
    }
    if (node.nodeType !== ELEMENT_NODE) continue
    // One space per element boundary: the surfaces nest the same words
    // differently, so only the words and their order can be compared.
    out += ` ${reportContentRunText(node as Element, surface)} `
  }
  return out
}

/**
 * Everything a reader sees inside one section, in document order. `scaffold`
 * is the section's own eyebrow, title and intro, which the outline records
 * separately.
 */
export function readReportContent(
  section: Element,
  scaffold: ReadonlySet<Element>,
  surface: ReportContentSurface,
): ReportContentEntry[] {
  const entries: ReportContentEntry[] = []
  let run = ''
  const flush = () => {
    const text = collapse(run)
    run = ''
    if (text !== '') entries.push({ text })
  }
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      run += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const element = node as Element
    if (scaffold.has(element) || isSkipped(element)) return

    if (element.tagName === 'TR') {
      // Header rows are the outline's `table` item; only bodies are read here.
      if (element.closest('thead')) return
      flush()
      const cells = Array.from(element.children).filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')
      entries.push({ row: cells.map(cell => reportContentRunText(cell, surface)) })
      return
    }
    if (element.tagName === 'SUMMARY') {
      flush()
      entries.push({ summary: reportContentRunText(element, surface) })
      return
    }
    if (element.tagName === 'LI' || surface.isListRow(element)) {
      flush()
      entries.push({ item: reportContentRunText(element, surface) })
      return
    }
    if (surface.isTile(element)) {
      flush()
      entries.push({ tile: reportContentRunText(element, surface) })
      return
    }
    if (surface.isCopyUnit(element)) {
      flush()
      const text = surface.overrideText(element) ?? reportContentRunText(element, surface)
      if (text !== '') entries.push({ text })
      return
    }
    // A wrapper that states a tone or a link target, with no unit under it, is
    // read whole so the marker lands where the reader sees the colour.
    if ((surface.tone(element) !== null || element.tagName === 'A') && !containsUnit(element, surface)) {
      run += ` ${reportContentRunText(element, surface)} `
      return
    }
    run += ' '
    for (const child of Array.from(element.childNodes)) visit(child)
    run += ' '
  }
  for (const child of Array.from(section.childNodes)) visit(child)
  flush()
  return entries
}
