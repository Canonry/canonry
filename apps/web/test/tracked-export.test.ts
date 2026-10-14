import { describe, expect, test } from 'vitest'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { trackedCsvFileName, trackedRowsCsv } from '../src/components/project/queries/advanced/tracked-export.js'
import { coverageByQuery, marksSubject, toTrackedRows, type TrackedResults } from '../src/components/project/queries/advanced/tracked-view-model.js'

// The CSV of the Tracked list: one line per query and type, the wire's names in the header, whose results each line holds, and three states per signal.

type Row = QueryTrackingTrackedRow
type Assignment = Row['assignments'][number]

const context = { providers: ['openai', 'gemini'], models: { openai: 'model-a', gemini: 'model-b' }, location: null }
const pairing = (targetKey: string, queryClass: Assignment['queryClass'], contexts: Assignment['contexts'] = [context]): Assignment =>
  ({ targetKey, groupKeys: [], marketKeys: [], queryClass, classificationSource: 'server', contexts })
const MEASURED_AT = '2026-10-07T12:10:00.000Z'
function tracked(queryId: string, queryText: string, focus: Row['focus'], assignments: Assignment[], overrides: Partial<Row> = {}): Row {
  return {
    queryId, queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
    state: 'tracked', lastMeasuredAt: MEASURED_AT, assignments, focus,
    queryClasses: [...new Set(assignments.flatMap(assignment => assignment.queryClass ?? []))].sort(),
    ...overrides,
  }
}
const TARGETS = [{ stableKey: 'harbor', label: 'Harbor Point' }, { stableKey: 'pier', label: 'Pier House' }, { stableKey: 'quay', label: 'Quay Lofts' }]
const LABELS = new Map(TARGETS.map(target => [target.stableKey, target.label]))
/** Whose results a line holds, as the page says it with no Place chosen: the locations of the row's own links, of the line's type. */
const marksFor = (row: ReturnType<typeof rowsOf>[number], queryClass: string) => marksSubject(row, row.tracked.assignments, LABELS, queryClass)
/** The page's own rows for these workspace rows, so the file is built from what the table holds. */
function rowsOf(rows: Row[]) {
  const workspace = {
    targets: TARGETS,
    markets: [{ stableKey: 'uptown', label: 'Uptown, Lakeshore', usageEdges: [], targetKeys: ['harbor', 'pier'] }],
    tracked: rows,
  } as unknown as QueryTrackingWorkspaceResponse
  return toTrackedRows(workspace, [{ id: 'template-best', name: 'Best' }])
}
const engine = (provider: string, mentioned: boolean | null, cited: boolean | null) => ({ provider, answers: 2, mentionedAnswers: mentioned ? 1 : 0, citedAnswers: cited ? 1 : 0, uncheckedSourceAnswers: 0, mentioned, cited })
const coverage = (rows: TrackedResults['rows']) => coverageByQuery({ rows })
/** The file as lines of cells. No cell of these fixtures holds a comma, unless a test says so. */
const lines = (csv: string) => csv.trimEnd().split('\r\n').map(line => line.split(','))

describe('trackedRowsCsv', () => {
  test('names its columns as the wire does, with a mentioned and a cited column per engine in the order given', () => {
    const csv = trackedRowsCsv([], ['openai', 'gemini'], coverage([]))
    // `marks_for` follows `place`: the place a query is about is not always whose results the line holds.
    expect(csv).toBe('query,query_class,subject,place,marks_for,status,last_measured,source,openai_mentioned,openai_cited,gemini_mentioned,gemini_cited\r\n')
  })

  test('a query asked both ways is two lines, each with its own type and that type\'s results', () => {
    const picked = tracked('q-picked', 'apartments with a pool', { kind: 'custom' }, [pairing('harbor', 'branded'), pairing('pier', 'non-brand')])
    const csv = trackedRowsCsv(rowsOf([picked]), ['openai', 'gemini'], coverage([
      { queryId: 'q-picked', queryClass: 'branded', engines: [engine('openai', true, true), engine('gemini', true, false)] },
      { queryId: 'q-picked', queryClass: 'non-brand', engines: [engine('openai', false, false), engine('gemini', false, true)] },
    ]), marksFor)
    // Never one line for both: a Branded yes is not borrowed by the Non-brand line, nor the other way.
    expect(lines(csv).slice(1)).toEqual([
      // `place` is the query's own two locations; `marks_for` is the one each line's results are of.
      ['apartments with a pool', 'Branded', 'Hand-picked', '2 locations', 'Harbor Point', 'Measured', MEASURED_AT, 'Manual', 'yes', 'yes', 'yes', 'no'],
      ['apartments with a pool', 'Non-brand', 'Hand-picked', '2 locations', 'Pier House', 'Measured', MEASURED_AT, 'Manual', 'no', 'no', 'no', 'yes'],
    ])
  })

  test('not checked is its own word: a signal the sweep did not check, an engine with no result and a query with no result are never a no', () => {
    // The market lists two locations and this row is asked for three: the line says whose results it holds from the row's own links.
    const market = tracked('q-market', 'best apartments uptown', { kind: 'market', key: 'uptown' }, [pairing('harbor', 'non-brand'), pairing('pier', 'non-brand'), pairing('quay', 'non-brand')], {
      provenance: { source: 'template', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z', template: { templateId: 'template-best', templateVersion: '1', template: 'best apartments {market}', bindings: { market: 'uptown' }, output: 'best apartments uptown' } },
    })
    const waiting = tracked('q-new', 'Pier House reviews', { kind: 'property', key: 'pier' }, [pairing('pier', 'branded')], { state: 'awaiting-sweep', lastMeasuredAt: null })
    const csv = trackedRowsCsv(rowsOf([market, waiting]), ['openai', 'gemini'], coverage([
      // Mentioned, with sources only partly saved: cited is not read from mentioned. The row is asked on Gemini, and the sweep holds no Gemini result for it.
      { queryId: 'q-market', queryClass: 'non-brand', engines: [engine('openai', true, null)] },
    ]), marksFor)
    // A market's name holds a comma here, so each cell that carries it is quoted.
    expect(csv.split('\r\n').slice(1, 3)).toEqual([
      `best apartments uptown,Non-brand,Market,"Uptown, Lakeshore","Any of 3 locations in Uptown, Lakeshore",Measured,${MEASURED_AT},Pattern: Best,yes,not checked,not checked,not checked`,
      'Pier House reviews,Branded,Location,Pier House,Pier House,First answers,,Manual,not checked,not checked,not checked,not checked',
    ])
  })

  test('an engine a query is not asked on is an empty cell, not a sweep gap', () => {
    const openaiOnly = { providers: ['openai'], models: {}, location: null }
    // Asked on OpenAI and Gemini between its two locations, never on Claude.
    const picked = tracked('q-picked', 'apartments with a pool', { kind: 'custom' }, [pairing('harbor', 'branded', [openaiOnly]), pairing('pier', 'branded')])
    const csv = trackedRowsCsv(rowsOf([picked]), ['openai', 'gemini', 'claude'], coverage([
      { queryId: 'q-picked', queryClass: 'branded', engines: [engine('openai', true, false)] },
    ]), marksFor)
    expect(lines(csv)[1]!.slice(-6)).toEqual(['yes', 'no', 'not checked', 'not checked', '', ''])
    // A result the sweep still holds on an engine the query is no longer asked on is written as it reads on the page.
    const older = trackedRowsCsv(rowsOf([picked]), ['claude'], coverage([{ queryId: 'q-picked', queryClass: 'branded', engines: [engine('claude', false, false)] }]))
    expect(lines(older)[1]!.slice(-2)).toEqual(['no', 'no'])
  })

  test('a query that is asked nowhere is one line with no type, no one its results are for and no result, whatever an older sweep holds for it', () => {
    const old = tracked('q-old', 'apartments in the old town', { kind: 'not-asked' }, [], { state: 'awaiting-sweep', lastMeasuredAt: null, provenance: null })
    const csv = trackedRowsCsv(rowsOf([old]), ['openai'], coverage([{ queryId: 'q-old', queryClass: 'unknown', engines: [engine('openai', true, true)] }]), marksFor)
    // Not asked is not "not checked": the engine cells are empty, and the Status says why.
    expect(lines(csv).slice(1)).toEqual([['apartments in the old town', 'Not set', 'None', '', '', 'Not asked', '', 'Older list', '', '']])
  })

  test('quotes a cell that holds a comma, a quote or a line break, and opens one a spreadsheet would run as a formula with a quote', () => {
    const texts = ['apartments, with a pool', 'the "best" apartments', 'two\nlines', '=SUM(A1:A9)', '  +1 apartments', '-apartments', '@apartments', 'plain apartments']
    const rows = rowsOf(texts.map((text, index) => tracked(`q-${index}`, text, { kind: 'property', key: 'harbor' }, [pairing('harbor', 'branded')])))
    const csv = trackedRowsCsv(rows, [], coverage([]))
    // No Place's reading was given, so `marks_for` is empty.
    const rest = ',Branded,Location,Harbor Point,,Measured,' + MEASURED_AT + ',Manual'
    expect(csv).toBe([
      'query,query_class,subject,place,marks_for,status,last_measured,source',
      `"apartments, with a pool"${rest}`,
      `"the ""best"" apartments"${rest}`,
      `"two\nlines"${rest}`,
      `'=SUM(A1:A9)${rest}`,
      `'  +1 apartments${rest}`,
      `'-apartments${rest}`,
      `'@apartments${rest}`,
      `plain apartments${rest}`,
      '',
    ].join('\r\n'))
  })

  test('while the results are still being read every signal is not checked, never a no', () => {
    const market = tracked('q-market', 'best apartments uptown', { kind: 'market', key: 'uptown' }, [pairing('harbor', 'non-brand')])
    expect(lines(trackedRowsCsv(rowsOf([market]), ['openai'], undefined))[1]!.slice(-2)).toEqual(['not checked', 'not checked'])
  })
})

describe('trackedCsvFileName', () => {
  const day = new Date('2026-10-10T23:30:00.000Z')

  test('names the file for the project and the day, with nothing a file name cannot hold', () => {
    expect(trackedCsvFileName('acme-homes', {}, day)).toBe('canonry-tracked-queries-acme-homes-2026-10-10.csv')
    expect(trackedCsvFileName('acme homes/north', undefined, day)).toBe('canonry-tracked-queries-acme_homes_north-2026-10-10.csv')
  })

  test('a file of one place carries its key, and a file of a searched or filtered list says filtered, so neither reads as the whole project', () => {
    expect(trackedCsvFileName('acme-homes', { placeKey: 'uptown' }, day)).toBe('canonry-tracked-queries-acme-homes-uptown-2026-10-10.csv')
    expect(trackedCsvFileName('acme-homes', { filtered: true }, day)).toBe('canonry-tracked-queries-acme-homes-filtered-2026-10-10.csv')
    expect(trackedCsvFileName('acme-homes', { placeKey: 'north side/2', filtered: true }, day)).toBe('canonry-tracked-queries-acme-homes-north_side_2-filtered-2026-10-10.csv')
    expect(trackedCsvFileName('acme-homes', { placeKey: undefined, filtered: false }, day)).toBe('canonry-tracked-queries-acme-homes-2026-10-10.csv')
  })
})
