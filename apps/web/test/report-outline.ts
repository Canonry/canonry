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
 *   `share-of-voice`; the HTML report writes the same band as loose notes
 *   between sections, which its reader collects under the same id.
 * - the scaffold is `[data-report-eyebrow]`, the first `h2`, and
 *   `[data-report-intro]`.
 * - then, in document order: `[data-report-heading]`, `[data-report-tile]`,
 *   each `table` (its header cells), `[data-report-empty]`, and
 *   `[data-report-note]`. Anything inside `.sr-only` is skipped: those are
 *   chart data tables for screen readers, which the HTML report does not have.
 *
 * A note rendered as an InfoTooltip is read from the trigger's accessible
 * name, which is where the tooltip keeps its text.
 *
 * `content` — the values, cells, badges, rows, links and summaries a reader
 * reads — comes from the SAME walker the HTML report uses
 * (`packages/api-routes/test/report-reading.ts`); only the vocabulary below is
 * the SPA's. See that module for the normalization and for what it excludes by
 * kind, the SPA's own interactive controls included.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import type { ReportAudience } from '@ainyc/canonry-contracts'
// The walker itself, not the HTML reader around it: `report-reading.ts` works
// on any `Element` and imports nothing, while `report-outline.ts` pulls in
// jsdom at module scope, which no SPA suite has any use for.
import {
  readReportContent,
  type ReportContentSurface,
  type ReportContentTone,
} from '../../../packages/api-routes/test/report-reading.js'
import type { ReportOutline, ReportOutlineItem, ReportOutlineSection } from '../../../packages/api-routes/test/report-outline.js'

export type { ReportOutline, ReportOutlineItem, ReportOutlineSection }

/** The fixtures with a committed outline golden per audience. */
export type ReportOutlineFixture = 'empty' | 'full' | 'advanced' | 'truncated'

const GOLDEN_DIR = resolve(import.meta.dirname, '../../../packages/api-routes/test/fixtures/report-outline')

/**
 * Render in the timezone the goldens were written in. A sweep timestamp is a
 * real moment, so BOTH renderers localize it for whoever is reading — and the
 * goldens come from `report-renderer-bytes.test.ts`, which pins UTC for exactly
 * this reason. Without the same pin here, a trend row stamped at UTC midnight
 * reads a day earlier on any machine west of Greenwich and the content
 * comparison fails on the clock rather than on the report. Call from a file
 * that compares content goldens.
 */
export function pinReportGoldenTimeZone(): void {
  let original: string | undefined
  beforeAll(() => {
    original = process.env.TZ
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
}

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

/**
 * The SPA's outline, comparable with `reportOutlineGolden`.
 *
 * Share of voice is a band, not a `<section>`, in the HTML report: it is two
 * loose notes between sections, which the HTML reader collects into a
 * pseudo-section of the same id. It renders NOTHING on either surface when the
 * report has no share figure — the SPA still emits the empty slot, the HTML
 * emits no notes — so an empty band is dropped here, exactly as the HTML has
 * nothing to collect. A band one surface fills and the other does not still
 * fails.
 */
export function readReportOutline(root: ParentNode): ReportOutline {
  const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-report-section]'), readSection)
    .filter(section => section.id !== 'share-of-voice' || section.items.length > 0 || section.content.length > 0)
  return { sections }
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
  const scaffold = new Set<Element>(
    [eyebrow, title, intro].filter((element): element is Element => element !== null),
  )
  return {
    id: section.dataset.reportSection ?? '',
    eyebrow: eyebrow ? normalizeOutlineText(eyebrow.textContent) : null,
    title: title ? normalizeOutlineText(title.textContent) : null,
    intro: intro ? normalizeOutlineText(intro.textContent) : null,
    items,
    content: readReportContent(section, scaffold, SPA_SURFACE),
  }
}

/**
 * `text-positive-400`, the badge variants' `text-caution`, and the insight
 * card's `insight-card-negative` all state the same three tones. Neutral
 * (`text-heading`, `text-neutral`, `insight-card` with no accent) states none —
 * the HTML report leaves the same things unmarked.
 */
const SPA_TONE = /^(?:text|insight-card)-(positive|caution|negative)(?:-\d{2,3})?$/

/**
 * The words an InfoTooltip beside this element keeps on its trigger, or null.
 *
 * `:scope >` on purpose: a note that carries prose AND a tooltip for one term
 * inside it would otherwise report the sub-term's explanation as the whole
 * note. An empty accessible name is null rather than `''`, so every caller's
 * `??` falls through to the element's own words instead of reading nothing.
 */
function tooltipText(element: Element): string | null {
  const trigger = element.querySelector(':scope > .info-tooltip-wrapper > button.info-tooltip-trigger')
  return normalizeOutlineText(trigger?.getAttribute('aria-label')) || null
}

const SPA_SURFACE: ReportContentSurface = {
  tone(element) {
    for (const token of Array.from(element.classList)) {
      const match = SPA_TONE.exec(token)
      if (match) return match[1] as ReportContentTone
    }
    return null
  },
  // `title` where the HTML report uses `title`, and the InfoTooltip beside a
  // value where it uses one — the same words either way. A note is excluded:
  // there the tooltip IS the note's words, read through `overrideText`.
  tip: element => (element.hasAttribute('data-report-note')
    ? null
    : normalizeOutlineText(element.getAttribute('title')) || tooltipText(element)),
  isTile: element => Array.from(element.children).some(child => child.hasAttribute('data-report-tile')),
  // Every SPA list row is an `li`; only the HTML report writes one as a `div`.
  isListRow: () => false,
  isCopyUnit: element =>
    element.hasAttribute('data-report-heading')
    || element.hasAttribute('data-report-note')
    || element.hasAttribute('data-report-empty'),
  // A note rendered as an InfoTooltip keeps its words on the trigger button,
  // which the walker skips along with every other interactive control. A note
  // that has words of its own keeps them: overriding on the mere PRESENCE of a
  // trigger would drop the sentence the reader sees.
  overrideText: element => (element.hasAttribute('data-report-note') && noteText(element) === ''
    ? tooltipText(element)
    : null),
}

/** A note's own visible words, ignoring any tooltip trigger inside it. */
function noteText(element: Element): string {
  return normalizeOutlineText(Array.from(element.childNodes)
    .filter(node => !(node instanceof Element && node.classList.contains('info-tooltip-wrapper')))
    .map(node => node.textContent ?? '')
    .join(''))
}

function classify(element: Element): ReportOutlineItem | null {
  if (element.hasAttribute('data-report-heading')) return { heading: normalizeOutlineText(element.textContent) }
  if (element.hasAttribute('data-report-tile')) return { tile: normalizeOutlineText(element.textContent) }
  if (element.tagName === 'TABLE') {
    return { table: Array.from(element.querySelectorAll('thead th'), header => normalizeOutlineText(header.textContent)) }
  }
  if (element.hasAttribute('data-report-empty')) return { empty: normalizeOutlineText(element.textContent) }
  if (element.hasAttribute('data-report-note')) {
    return { note: noteText(element) || tooltipText(element) || '' }
  }
  return null
}
