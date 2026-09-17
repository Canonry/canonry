/**
 * Outline of a rendered report: the copy and structure a reader scans in each
 * section, in document order, without the numbers.
 *
 * The HTML renderer and the SPA must produce the SAME outline for the same DTO
 * and audience. This module reads it from rendered HTML. The committed goldens
 * in `fixtures/report-outline/` are written from it by
 * `report-renderer-bytes.test.ts`, and the web suite reads the same shape from
 * the SPA DOM through `data-report-*` hooks (`apps/web/test/report-outline.ts`)
 * and compares against those files. Only this package regenerates them, so a
 * SPA-only change can never "fix" parity by rewriting a golden.
 *
 * Per section: `eyebrow` is the direct `.eyebrow` child, `title` the `h2`, and
 * `intro` the `p.section-intro` directly after the `h2`. Every other element is
 * read in document order into one of these item kinds:
 *
 * - `heading`: an `h3` (card, chart and table titles; action, diagnostic and
 *   opportunity titles).
 * - `tile`: a metric tile label (`.metric > .label`,
 *   `.client-metric-tile > .label`, `.mini-label`, `.scope-label`).
 * - `table`: a table's header cells, in order.
 * - `empty`: an empty state (`.empty-state`).
 * - `note`: supporting copy (`p.meta`, `.chart-note`, `.card-subtitle`,
 *   `.client-confidence-note`, `.client-explainer`, `.source-origin-headline`,
 *   `.scope-warning`, and any `p.section-intro` that is not the section intro).
 *
 * A classified element is read whole; nothing inside it is classified again.
 * Text is whitespace-normalized. Share-of-voice notes sit between sections
 * rather than inside one, so they are collected into a pseudo-section of their
 * own (see `shareOfVoiceSection`); the page header and footer are the only
 * rendered copy deliberately left out, for the reasons on `reportHtmlOutline`.
 *
 * `content` is the second half of the golden: what a reader READS in the
 * section — tile values and subtitles, table body cells, badges and their tone,
 * delta tones, list and step rows, link targets, details summaries. The outline
 * above is the section's skeleton, and on its own it let the two surfaces
 * disagree about every number in them. See `report-reading.ts` for the
 * normalization and for what is excluded by kind.
 */
import { JSDOM } from 'jsdom'
import {
  readReportContent,
  type ReportContentEntry,
  type ReportContentSurface,
  type ReportContentTone,
} from './report-reading.js'

export type { ReportContentEntry, ReportContentSurface, ReportContentTone }
export { readReportContent }

export type ReportOutlineItem =
  | { heading: string }
  | { tile: string }
  | { table: string[] }
  | { empty: string }
  | { note: string }

export interface ReportOutlineSection {
  id: string
  eyebrow: string | null
  title: string | null
  intro: string | null
  items: ReportOutlineItem[]
  content: ReportContentEntry[]
}

export interface ReportOutline {
  sections: ReportOutlineSection[]
}

const TILE_LABEL = '.metric > .label, .client-metric-tile > .label, .mini-label, .scope-label'
const NOTE = 'p.meta, .chart-note, .card-subtitle, .client-confidence-note, .client-explainer, .source-origin-headline, .scope-warning, p.section-intro'

/** Collapse runs of whitespace the way a reader sees rendered text. */
export function normalizeOutlineText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function parseReportHtml(html: string): Document {
  return new JSDOM(html).window.document
}

/** Section ids in document order. Share of voice is not a `<section>` in the HTML report. */
export function reportHtmlSectionIds(html: string): string[] {
  return Array.from(parseReportHtml(html).querySelectorAll('section[id]'), section => section.id)
}

/**
 * The share-of-voice band: percentage and reason, which the HTML report writes
 * as loose `.chart-note` siblings BETWEEN sections rather than as a section of
 * its own. Scoping the outline to `section[id]` left it in no section at all,
 * so a one-surface rewrite of the copy passed. Consecutive notes become one
 * pseudo-section, because the SPA wraps the same paragraphs in a single
 * `[data-report-section="share-of-voice"]`.
 */
const SHARE_OF_VOICE_NOTE = '.chart-note'

function shareOfVoiceSection(notes: readonly Element[]): ReportOutlineSection {
  const band = notes[0]!.ownerDocument.createElement('div')
  // The paragraphs, not the note wrappers: the SPA has one wrapper, the HTML
  // one per query class, and a reader reads the same lines either way.
  for (const note of notes) for (const child of Array.from(note.children)) band.append(child.cloneNode(true))
  return {
    id: 'share-of-voice',
    eyebrow: null,
    title: null,
    intro: null,
    items: [],
    content: readReportContent(band, new Set(), HTML_SURFACE),
  }
}

/**
 * Every rendered band in document order. The page `<header>` and `<footer>`
 * stay out on purpose: the footer is the downloadable file's own attribution
 * with no SPA counterpart (the byte snapshots pin it), and the header's line
 * has its own parity test in `apps/web/test/report-page.test.tsx`.
 */
export function reportHtmlOutline(html: string): ReportOutline {
  const sections: ReportOutlineSection[] = []
  let notes: Element[] = []
  const flushNotes = () => {
    if (notes.length > 0) sections.push(shareOfVoiceSection(notes))
    notes = []
  }
  for (const element of Array.from(parseReportHtml(html).querySelectorAll(`section[id], ${SHARE_OF_VOICE_NOTE}`))) {
    if (element.matches(SHARE_OF_VOICE_NOTE)) {
      // Only the loose ones. A `.chart-note` inside a section is that section's
      // note, and the outline already reads it there.
      if (!element.closest('section[id]')) notes.push(element)
      continue
    }
    flushNotes()
    sections.push(readSection(element))
  }
  flushNotes()
  return { sections }
}

function readSection(section: Element): ReportOutlineSection {
  const children = Array.from(section.children)
  const eyebrow = children.find(child => child.matches('.eyebrow')) ?? null
  const title = children.find(child => child.tagName === 'H2') ?? null
  const afterTitle = title?.nextElementSibling ?? null
  const intro = afterTitle?.matches('p.section-intro') ? afterTitle : null
  const scaffold = new Set<Element>([eyebrow, title, intro].filter((element): element is Element => element !== null))
  const items: ReportOutlineItem[] = []
  const visit = (element: Element) => {
    if (scaffold.has(element)) return
    const item = classify(element)
    if (item) {
      items.push(item)
      return
    }
    for (const child of Array.from(element.children)) visit(child)
  }
  for (const child of children) visit(child)
  return {
    id: section.id,
    eyebrow: eyebrow ? normalizeOutlineText(eyebrow.textContent) : null,
    title: title ? normalizeOutlineText(title.textContent) : null,
    intro: intro ? normalizeOutlineText(intro.textContent) : null,
    items,
    content: readReportContent(section, scaffold, HTML_SURFACE),
  }
}

/**
 * Every class the downloadable report states a tone with. Most are the shared
 * `tone-*` modifiers, but two components hard-code a tone colour of their own:
 * a cited scorecard glyph is drawn in the positive colour (the SPA gives it
 * `text-positive-400`), and the market-scope warning is a caution card (the SPA
 * gives it `insight-card-caution`). `tone-neutral` is deliberately absent:
 * neutral reads as no tone on both surfaces (see `report-reading.ts`).
 */
const HTML_TONES: Readonly<Record<string, ReportContentTone>> = {
  'tone-positive': 'positive',
  'tone-caution': 'caution',
  'tone-negative': 'negative',
  'cell-cited': 'positive',
  'scope-warning': 'caution',
}

/**
 * The two lists the downloadable report writes without `li`: the recommended
 * next steps, and the indexing-coverage legend. The SPA writes both as `li`.
 */
const HTML_LIST_ROW = '.step, .legend > span'

const HTML_SURFACE: ReportContentSurface = {
  tone(element) {
    for (const token of Array.from(element.classList)) {
      const tone = HTML_TONES[token]
      if (tone) return tone
    }
    return null
  },
  // The downloadable report has no scripting, so every hover explanation is a
  // `title`. The SPA states the same words through an InfoTooltip.
  tip: element => normalizeOutlineText(element.getAttribute('title')) || null,
  // A tile is whatever holds one of the outline's tile labels, so both readings
  // of a tile come from one definition.
  isTile: element => Array.from(element.children).some(child => child.matches(TILE_LABEL)),
  isListRow: element => element.matches(HTML_LIST_ROW),
  isCopyUnit: element => element.tagName === 'H3' || element.matches(NOTE) || element.matches('.empty-state'),
  overrideText: () => null,
}

function classify(element: Element): ReportOutlineItem | null {
  if (element.tagName === 'H3') return { heading: normalizeOutlineText(element.textContent) }
  if (element.tagName === 'TABLE') {
    return { table: Array.from(element.querySelectorAll('thead th'), header => normalizeOutlineText(header.textContent)) }
  }
  if (element.matches(TILE_LABEL)) return { tile: normalizeOutlineText(element.textContent) }
  if (element.matches('.empty-state')) return { empty: normalizeOutlineText(element.textContent) }
  if (element.matches(NOTE)) return { note: normalizeOutlineText(element.textContent) }
  return null
}
