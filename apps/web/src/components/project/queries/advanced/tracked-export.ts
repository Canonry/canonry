import type { QueryTrackingResultGroup } from '@canonry/canonry-contracts'

import type { TrackedRowVm } from './tracked-types.js'
import { locationCountLabel, NOT_ASKED, resultClasses, rowSignal, sourceLabel, statusLabel, subjectKindLabel, typeLabel, type TrackedCoverage } from './tracked-view-model.js'

/**
 * The Tracked list as a CSV file: the rows the page lists, in its order, over
 * every page. One line per query and type, so a query asked both ways is two
 * lines and Branded and Non-brand results are never one line. The headers
 * keep the wire's names; the cells read as the page does. `place` is the
 * market or location the query is about; `marks_for` is whose mention or
 * citation the line's results are, in the Place the page was on.
 */

const COLUMNS = ['query', 'query_class', 'subject', 'place', 'marks_for', 'status', 'last_measured', 'source'] as const

/** Three states, as a chip has them. No result, and a signal the sweep did not check, are not a no. */
const signalWord = (value: boolean | null | undefined) => value === true ? 'yes' : value === false ? 'no' : 'not checked'

/** The market or location a query is about, or how many locations a hand-picked one is asked for. */
function placeOf(subject: TrackedRowVm['subject']): string {
  if (subject.kind === 'market' || subject.kind === 'location') return subject.label
  return subject.kind === 'hand-picked' ? locationCountLabel(subject.locationCount) : ''
}

/**
 * One cell. Text a spreadsheet would run as a formula opens with a quote, as
 * the server's results export writes it, and a cell holding a comma, a quote
 * or a line break is quoted.
 */
function cell(value: string): string {
  const text = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * `rows` as CSV, with two columns per engine: `{engine}_mentioned` and
 * `{engine}_cited`, each yes, no or not checked. Neither is read from the
 * other. Both are empty where the query is not asked on that engine, and on
 * every engine for a query that is not asked: not asked is not a sweep gap.
 * `marksFor` gives a line's `marks_for` (`marksSubject`), empty without it.
 */
export function trackedRowsCsv(rows: readonly TrackedRowVm[], engines: readonly string[], coverage: TrackedCoverage | undefined, marksFor?: (row: TrackedRowVm, queryClass: string) => string | undefined): string {
  const header = [...COLUMNS, ...engines.flatMap(engine => [`${engine}_mentioned`, `${engine}_cited`])]
  const lines = rows.flatMap(row => resultClasses(row).map((queryClass, index) => [
    row.queryText,
    typeLabel(row.queryClasses[index] ?? 'not-set'),
    subjectKindLabel(row.subject.kind),
    placeOf(row.subject),
    marksFor?.(row, queryClass) ?? '',
    statusLabel(row.status),
    row.lastMeasuredAt ?? '',
    sourceLabel(row.source),
    ...engines.flatMap(engine => {
      const signal = rowSignal(row, coverage, queryClass, engine)
      return signal === NOT_ASKED ? ['', ''] : [signalWord(signal?.mentioned), signalWord(signal?.cited)]
    }),
  ]))
  return `${[header, ...lines].map(line => line.map(cell).join(',')).join('\r\n')}\r\n`
}

/**
 * The Markets list as a CSV file: one line per market (or group of markets)
 * and type, never pooled, in the list's order. Each rate is the server's two
 * counts and its rate; each engine has its mentioned, cited and answer
 * counts; the change is the counts won and lost since the previous sweep; and
 * the names and sites given instead, with their answer counts, are the
 * non-brand answers', so they sit on the non-brand line. Nothing is counted
 * here.
 */
export function trackedMarketsCsv(groups: readonly QueryTrackingResultGroup[], engines: readonly string[]): string {
  const rate = (value: { numerator: number | null; denominator: number | null; rate: number | null }) => [value.numerator ?? '', value.denominator ?? '', value.rate ?? ''].map(String)
  const header = [
    'kind', 'key', 'label', 'locations', 'query_class', 'queries', 'answers',
    'mentioned', 'mention_answers', 'mention_rate', 'cited', 'cite_answers', 'cite_rate', 'other_location_mentioned',
    ...engines.flatMap(engine => [`${engine}_answers`, `${engine}_mentioned`, `${engine}_cited`]),
    'mentions_won', 'mentions_lost', 'citations_won', 'citations_lost', 'named_instead', 'cited_instead', 'competitors',
  ]
  const lines = groups.flatMap(group => group.types.map(type => {
    const nonBrand = type.queryClass === 'non-brand'
    return [
      group.kind, group.key, group.label, String(group.locations), type.queryClass, String(type.queries), String(type.answers),
      ...rate(type.mentionCoverage), ...rate(type.citationCoverage), String(type.otherLocationMentionedAnswers),
      ...engines.flatMap(engine => {
        const entry = type.engines.find(candidate => candidate.provider === engine)
        return entry ? [String(entry.answers), String(entry.mentionedAnswers), String(entry.citedAnswers)] : ['', '', '']
      }),
      ...(type.change ? [type.change.mentionsWon, type.change.mentionsLost, type.change.citationsWon, type.change.citationsLost].map(String) : ['', '', '', '']),
      nonBrand ? group.namedInstead.map(entry => `${entry.name} (${entry.answers})`).join('; ') : '',
      nonBrand ? group.citedInstead.map(entry => `${entry.host} (${entry.answers})`).join('; ') : '',
      nonBrand ? group.competitors.map(entry => `${entry.domain} (named ${entry.mentionedAnswers}, cited ${entry.citedAnswers})`).join('; ') : '',
    ]
  }))
  return `${[header, ...lines].map(line => line.map(cell).join(',')).join('\r\n')}\r\n`
}

/** What narrowed the list a file holds: the Place's key, whether a search or a filter was on, and what its lines are. */
export type TrackedCsvNarrowing = { placeKey?: string; filtered?: boolean; kind?: 'queries' | 'markets' | 'market-groups' }

const fileNamePart = (value: string) => value.replace(/[^\w.-]+/g, '_')

/**
 * "canonry-tracked-queries-acme-2026-10-10.csv": the project and the day, as
 * the results export names its file. A file of one place carries that place's
 * key, and one of a searched or filtered list says "filtered", so neither is
 * taken for the whole project's.
 */
export function trackedCsvFileName(projectName: string, { placeKey, filtered, kind = 'queries' }: TrackedCsvNarrowing = {}, now = new Date()): string {
  const parts = [fileNamePart(projectName), ...(placeKey ? [fileNamePart(placeKey)] : []), ...(filtered ? ['filtered'] : []), now.toISOString().slice(0, 10)]
  return `canonry-tracked-${kind === 'queries' ? 'queries' : kind}-${parts.join('-')}.csv`
}

/** Hands the CSV to the browser as a file. It is built from what the page has read: nothing is requested. */
export function downloadTrackedCsv(projectName: string, csv: string, narrowing?: TrackedCsvNarrowing): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = trackedCsvFileName(projectName, narrowing)
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
