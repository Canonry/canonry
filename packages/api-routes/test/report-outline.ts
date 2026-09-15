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
 * Text is whitespace-normalized. Share-of-voice notes sit between sections, so
 * they are not part of any section's outline.
 */
import { JSDOM } from 'jsdom'

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

/** Section ids in document order. Share of voice is not a section in the HTML report. */
export function reportHtmlSectionIds(html: string): string[] {
  return Array.from(parseReportHtml(html).querySelectorAll('section[id]'), section => section.id)
}

export function reportHtmlOutline(html: string): ReportOutline {
  return { sections: Array.from(parseReportHtml(html).querySelectorAll('section[id]'), readSection) }
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
  }
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
