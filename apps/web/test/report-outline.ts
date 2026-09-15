/**
 * Reads the report outline from the rendered SPA, in the shape the HTML
 * report's outline takes (`packages/api-routes/test/report-outline.ts`), so a
 * web test can compare the SPA against the committed goldens in
 * `packages/api-routes/test/fixtures/report-outline/`. Only the api-routes
 * suite writes those files, from the HTML, so a SPA change can never "fix"
 * parity by rewriting a golden.
 *
 * The SPA marks with `data-report-*` hooks what the HTML marks with classes:
 * - a section is `[data-report-section="<id>"]`. Share of voice carries
 *   `share-of-voice`, but it is not a section in the HTML report, so outlines
 *   leave it out while `readReportSectionIds` keeps it.
 * - the scaffold is `[data-report-eyebrow]`, the first `h2`, and
 *   `[data-report-intro]`.
 * - then, in document order: `[data-report-heading]`, `[data-report-tile]`,
 *   each `table` (its header cells), `[data-report-empty]`, and
 *   `[data-report-note]`. Anything inside `.sr-only` is skipped: those are
 *   chart data tables for screen readers, which the HTML report does not have.
 *
 * A note rendered as an InfoTooltip is read from the trigger's accessible
 * name, which is where the tooltip keeps its text.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReportAudience } from '@ainyc/canonry-contracts'
import type { ReportOutline, ReportOutlineItem, ReportOutlineSection } from '../../../packages/api-routes/test/report-outline.js'

export type { ReportOutline, ReportOutlineItem, ReportOutlineSection }

/** The fixtures with a committed outline golden per audience. */
export type ReportOutlineFixture = 'empty' | 'full' | 'advanced'

const GOLDEN_DIR = resolve(import.meta.dirname, '../../../packages/api-routes/test/fixtures/report-outline')

/** The HTML report's outline for one audience and fixture. */
export function reportOutlineGolden(audience: ReportAudience, fixture: ReportOutlineFixture): ReportOutline {
  return JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${audience}.${fixture}.json`), 'utf8')) as ReportOutline
}

/** One section's entry in an outline, or undefined when the outline has no such section. */
export function reportOutlineSection(outline: ReportOutline, id: string): ReportOutlineSection | undefined {
  return outline.sections.find(section => section.id === id)
}

/** Collapse runs of whitespace the way a reader sees rendered text. */
export function normalizeOutlineText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/** Every rendered report slot in document order, share of voice included. */
export function readReportSectionIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-report-section]'), element => element.dataset.reportSection ?? '')
}

/** The SPA's outline, comparable with `reportOutlineGolden`. */
export function readReportOutline(root: ParentNode): ReportOutline {
  const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-report-section]'))
    .filter(section => section.dataset.reportSection !== 'share-of-voice')
  return { sections: sections.map(readSection) }
}

function readSection(section: HTMLElement): ReportOutlineSection {
  const eyebrow = section.querySelector('[data-report-eyebrow]')
  const title = section.querySelector('h2')
  const intro = section.querySelector('[data-report-intro]')
  const items: ReportOutlineItem[] = []
  const visit = (element: Element) => {
    if (element === eyebrow || element === title || element === intro) return
    if (element.classList.contains('sr-only')) return
    const item = classify(element)
    if (item) {
      items.push(item)
      return
    }
    for (const child of Array.from(element.children)) visit(child)
  }
  for (const child of Array.from(section.children)) visit(child)
  return {
    id: section.dataset.reportSection ?? '',
    eyebrow: eyebrow ? normalizeOutlineText(eyebrow.textContent) : null,
    title: title ? normalizeOutlineText(title.textContent) : null,
    intro: intro ? normalizeOutlineText(intro.textContent) : null,
    items,
  }
}

function classify(element: Element): ReportOutlineItem | null {
  if (element.hasAttribute('data-report-heading')) return { heading: normalizeOutlineText(element.textContent) }
  if (element.hasAttribute('data-report-tile')) return { tile: normalizeOutlineText(element.textContent) }
  if (element.tagName === 'TABLE') {
    return { table: Array.from(element.querySelectorAll('thead th'), header => normalizeOutlineText(header.textContent)) }
  }
  if (element.hasAttribute('data-report-empty')) return { empty: normalizeOutlineText(element.textContent) }
  if (element.hasAttribute('data-report-note')) {
    const tooltip = element.querySelector('button.info-tooltip-trigger')
    return { note: normalizeOutlineText(tooltip ? tooltip.getAttribute('aria-label') : element.textContent) }
  }
  return null
}
