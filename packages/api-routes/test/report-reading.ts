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
 * - **An element boundary reads as a space, except inside a number.** Entering
 *   and leaving any element records a boundary, and a run of boundaries and
 *   whitespace collapses to one space — unless the run is pure boundary AND it
 *   sits beside a number, which keeps the number and the character next to it
 *   together (see `glues`). So a JSX split like
 *   `<span>{n}</span><span>%</span>` reads `65%`, exactly as the HTML's single
 *   `65%` does, while `<span>high competitor density</span><span>no own
 *   page</span>` — two spans this codebase separates with CSS, not with text —
 *   still reads `high competitor density no own page`.
 * - **Indentation is a boundary, not a space.** Whitespace carrying a NEWLINE
 *   is the HTML report's template-literal indentation, which JSX never emits
 *   (see `readText`); whitespace without one is a space the surface means,
 *   `{' '}` included. So neither surface's source formatting leaks into the
 *   reading — the HTML writing `<span>65</span>` and `<span>%</span>` on two
 *   lines still reads `65%`.
 * - **A marker never swallows the whitespace around it.** An element's own
 *   leading and trailing separators are emitted OUTSIDE its tone/tip/link
 *   marker, so `<span>{' · '}{part}</span>` beside a toned delta still reads
 *   `«positive|Up 100%…» · Paid 9` rather than gluing the separator to `»`.
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
 * A tone stated on a wrapper that HOLDS units — a diagnostics card, whose
 * accent is the whole point of the card — marks every unit inside it, rather
 * than being swallowed on the way past.
 *
 * ## Tips
 *
 * Copy a reader reveals by hovering or focusing is still copy, and it is the
 * one kind that lives in an attribute rather than in text: the HTML report
 * writes it as `title=`, the SPA as an `InfoTooltip` beside the same value
 * (whose words ride the trigger's `aria-label`). Both map onto one marker —
 * `«tip A score out of 100…|88»` — so a hardcoded string on either surface
 * shows up as a diff. A `title` that merely repeats the element's own words is
 * a truncation affordance, not copy, and states no tip.
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
  /** Copy this element hides behind a hover/focus affordance, or null. */
  tip(element: Element): string | null
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

/**
 * An element boundary. Unlike whitespace it is not a space the reader sees, so
 * it only separates two words — see the module doc. U+0000 cannot appear in
 * rendered copy, so it can never collide with content.
 */
const BREAK = '\u0000'

const WORD = /[\p{L}\p{N}_]/u
const DIGIT = /\p{N}/u
const WHITESPACE = /\s/

/** An element boundary or a character of whitespace: the two things that separate words. */
function isSeparator(char: string): boolean {
  return char === BREAK || WHITESPACE.test(char)
}

/** The characters this module writes markers with, which no report copy contains. */
const MARKER = /[«»|]/

/**
 * A number and the character beside it are ONE token, whichever way a surface
 * splits them across elements: `<span>{n}</span><span>%</span>` reads `65%`,
 * `88` beside `/100` reads `88/100`, `$` beside `1,200` reads `$1,200`. Only a
 * boundary glues — real whitespace is the surface spacing something on purpose
 * — and only around a number, so two words are never run together.
 *
 * This is the one place the reading is deliberately blind: a surface that
 * renders `88 / 100` compares equal to one rendering `88/100`. That is a
 * typographic difference, not a difference in what the report SAYS, and the
 * alternative — spacing every boundary — fails a one-surface refactor that
 * sizes a percent sign apart from its number.
 */
function glues(left: string, right: string): boolean {
  if (MARKER.test(left) || MARKER.test(right)) return false
  return (DIGIT.test(left) && !WORD.test(right)) || (!WORD.test(left) && DIGIT.test(right))
}

/**
 * Resolve whitespace and element boundaries the way a reader sees the rendered
 * line: each run becomes one space, except a run of pure boundaries that would
 * split a number from the character beside it.
 */
function collapse(value: string): string {
  let out = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]!
    if (!isSeparator(char)) {
      out += char
      index += 1
      continue
    }
    let spaced = false
    while (index < value.length && isSeparator(value[index]!)) {
      if (value[index] !== BREAK) spaced = true
      index += 1
    }
    // Leading and trailing separators are trimmed, as a browser trims them.
    if (out === '' || index >= value.length) continue
    if (spaced || !glues(out[out.length - 1]!, value[index]!)) out += ' '
  }
  return out
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

/** True when this element states something the walker records only as a marker. */
function statesMarker(element: Element, surface: ReportContentSurface): boolean {
  return surface.tone(element) !== null || surface.tip(element) !== null || element.tagName === 'A'
}

/** Wrap a reading in whatever markers this element states. */
function mark(element: Element, surface: ReportContentSurface, inner: string): string {
  if (inner === '') return ''
  const href = element.tagName === 'A' ? element.getAttribute('href') : null
  const tone = surface.tone(element)
  const tip = surface.tip(element)
  const linked = href ? `«link ${href}|${inner}»` : inner
  // A tip that repeats the words it sits on is a truncation affordance, not
  // copy: both surfaces set one on a cell that may be clipped.
  const tipped = tip !== null && tip !== inner ? `«tip ${tip}|${linked}»` : linked
  return tone ? `«${tone}|${tipped}»` : tipped
}

/**
 * One element read whole: its words in order, with a tone, tip or link marker
 * wrapping whichever run states one. Trimmed, because this is a finished
 * reading — a unit's entry, or a run about to be flushed.
 */
export function reportContentRunText(element: Element, surface: ReportContentSurface): string {
  return collapse(readElement(element, surface))
}

/** Separators a reading begins and ends with, split from the rest. */
function splitEdges(value: string): [string, string, string] {
  let start = 0
  while (start < value.length && isSeparator(value[start]!)) start += 1
  if (start === value.length) return [value, '', '']
  let end = value.length
  while (end > start && isSeparator(value[end - 1]!)) end -= 1
  return [value.slice(0, start), value.slice(start, end), value.slice(end)]
}

/**
 * One element read IN PLACE: the same reading, but with the separators it
 * begins and ends with left outside the marker, so the run it sits in can still
 * see them. Marking them inside would hide the space in `{' · '}` behind a `»`.
 */
function readElement(element: Element, surface: ReportContentSurface): string {
  if (isSkipped(element)) return ''
  const [lead, core, tail] = splitEdges(readChildren(element, surface))
  return `${lead}${mark(element, surface, collapse(core))}${tail}`
}

/**
 * A text node's words, with the HTML report's INDENTATION read as a boundary
 * rather than as a space.
 *
 * The one whitespace the two surfaces cannot agree on is the newline: the
 * downloadable report is a template literal, so every tag it writes on its own
 * line leaves indentation between the tags, and JSX emits none — Babel strips a
 * whitespace-only line and trims the ends of every other one, so no text node
 * React renders here contains a newline. Counting indentation would make
 * `<strong>Citation rate at 65%</strong>\n<span>Up from…</span>` read `65% Up`
 * in the HTML and `65%Up` in the SPA for a difference no reader can see. A
 * whitespace run with no newline is a space the surface MEANS — the SPA writes
 * it `{' '}` — and is kept.
 */
function readText(node: Node): string {
  return (node.nodeValue ?? '').replace(NEWLINE_RUN, BREAK)
}

const NEWLINE_RUN = /[^\S\n]*\n\s*/g

function readChildren(element: Element, surface: ReportContentSurface): string {
  let out = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      out += readText(node)
      continue
    }
    if (node.nodeType !== ELEMENT_NODE) continue
    // A boundary, not a space: the surfaces nest the same words differently, so
    // only the words, their order, and real whitespace can be compared.
    out += `${BREAK}${readElement(node as Element, surface)}${BREAK}`
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
  // Marker-stating wrappers currently open, outermost first. A tone on a card
  // that HOLDS units — the diagnostics cards on both surfaces — would otherwise
  // be dropped on the way past, identically on both, leaving the colour that
  // says "regression" unguarded.
  const open: Element[] = []
  const decorate = (text: string, ...also: Element[]): string =>
    [...open, ...also].reduceRight((inner, element) => mark(element, surface, inner), text)
  const flush = () => {
    const text = decorate(collapse(run))
    run = ''
    if (text !== '') entries.push({ text })
  }
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      run += readText(node)
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
      // The row's own marker paints every cell in it.
      entries.push({ row: cells.map(cell => decorate(reportContentRunText(cell, surface), element)) })
      return
    }
    if (element.tagName === 'SUMMARY') {
      flush()
      entries.push({ summary: decorate(reportContentRunText(element, surface)) })
      return
    }
    if (element.tagName === 'LI' || surface.isListRow(element)) {
      flush()
      entries.push({ item: decorate(reportContentRunText(element, surface)) })
      return
    }
    if (surface.isTile(element)) {
      flush()
      entries.push({ tile: decorate(reportContentRunText(element, surface)) })
      return
    }
    if (surface.isCopyUnit(element)) {
      flush()
      const text = decorate(surface.overrideText(element) ?? reportContentRunText(element, surface))
      if (text !== '') entries.push({ text })
      return
    }
    // A wrapper that states a tone, a tip or a link target, with no unit under
    // it, is read whole so the marker lands where the reader sees it. One that
    // HOLDS units stays open instead, and marks each of them.
    const marks = statesMarker(element, surface)
    if (marks && !containsUnit(element, surface)) {
      run += `${BREAK}${readElement(element, surface)}${BREAK}`
      return
    }
    if (marks) flush()
    run += BREAK
    if (marks) open.push(element)
    for (const child of Array.from(element.childNodes)) visit(child)
    if (marks) {
      flush()
      open.pop()
    }
    run += BREAK
  }
  for (const child of Array.from(section.childNodes)) visit(child)
  flush()
  return entries
}
