import { describe, expect, it } from 'vitest'
import { queryTrackingPreviewRequestSchema } from '@ainyc/canonry-contracts'
import type { QueryTrackingMutation } from '@ainyc/canonry-contracts'

import {
  allowedTypes,
  canChangeSubject,
  changeSubject,
  changeType,
  editWording,
  marketsHolding,
  moveLocation,
  reachesBeyond,
  rowMenuActions,
  rowTypeSetsSubject,
  sameSubject,
  stopTracking,
  typeChangeRows,
  typeSetsSubject,
  typeWouldChange,
  type TrackedPlace,
} from '../src/components/project/queries/advanced/tracked-actions.js'
import type { TrackedRowVm } from '../src/components/project/queries/advanced/tracked-types.js'
import { contextChoices, rows, uptownPlace, withSecondSearchLocation, withSource, workspace, workspaceVersion } from './support/tracked-action-fixtures.js'

/** The builder's request as built, once the preview route's own schema accepts it: a key the route does not know fails here. */
function sent(mutation: QueryTrackingMutation | null): QueryTrackingMutation {
  expect(mutation).not.toBeNull()
  expect(queryTrackingPreviewRequestSchema.safeParse({ ...mutation, expectedWorkspaceVersion: workspaceVersion }).error).toBeUndefined()
  return mutation!
}

const PLACES: [TrackedPlace, Record<string, string[]>][] = [
  [uptownPlace, { marketKeys: ['uptown'] }],
  [{ kind: 'group', key: 'north', label: 'North' }, { groupKeys: ['north'] }],
  [{ kind: 'location', key: 'harbor', label: 'Harbor Point' }, { targetKeys: ['harbor'] }],
]

describe('stopTracking', () => {
  it('sends one removal per row, for the whole query', () => {
    expect(sent(stopTracking([rows.market, rows.marketB, rows.location]))).toStrictEqual({
      additions: [],
      removals: [{ queryId: 'q-uptown' }, { queryId: 'q-uptown-b' }, { queryId: 'q-harbor' }],
    })
  })

  it.each(PLACES)('narrows every removal to the place %o', (place, audience) => {
    expect(sent(stopTracking([rows.market, rows.location], place))).toStrictEqual({
      additions: [],
      removals: [{ queryId: 'q-uptown', audience }, { queryId: 'q-harbor', audience }],
    })
  })
})

describe('editWording', () => {
  it('sends one edit with the trimmed text and no type', () => {
    expect(sent(editWording(rows.market, '  best apartments in uptown  '))).toStrictEqual({
      additions: [], removals: [], edits: [{ queryId: 'q-uptown', text: 'best apartments in uptown' }],
    })
  })

  it.each(PLACES)('narrows the edit to the place %o', (place, audience) => {
    expect(sent(editWording(rows.market, 'best apartments in uptown', place))).toStrictEqual({
      additions: [], removals: [], edits: [{ queryId: 'q-uptown', text: 'best apartments in uptown', audience }],
    })
  })
})

describe('changeType', () => {
  it('sends one edit per row with the type, and null for Automatic', () => {
    expect(sent(changeType([rows.handPicked, rows.location], 'branded'))).toStrictEqual({
      additions: [], removals: [], edits: [{ queryId: 'q-picked', queryClass: 'branded' }, { queryId: 'q-harbor', queryClass: 'branded' }],
    })
    expect(sent(changeType([rows.market], 'non-brand')).edits).toStrictEqual([{ queryId: 'q-uptown', queryClass: 'non-brand' }])
    // Null asks the server to classify again; leaving the key out would keep the type as it is.
    expect(sent(changeType([rows.operatorSet], 'auto')).edits).toStrictEqual([{ queryId: 'q-harbor-parking', queryClass: null }])
  })

  it.each(PLACES)('narrows every edit to the place %o', (place, audience) => {
    expect(sent(changeType([rows.market], 'non-brand', place)).edits).toStrictEqual([{ queryId: 'q-uptown', queryClass: 'non-brand', audience }])
  })
})

describe('changeSubject and moveLocation', () => {
  const uptownText = { source: 'manual', text: 'best apartments uptown' }

  it('sends one removal of the whole query and one addition of its text for a market', () => {
    expect(sent(changeSubject(rows.location, { kind: 'market', key: 'uptown' }, workspace))).toStrictEqual({
      additions: [{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { marketKeys: ['uptown'] } }],
      removals: [{ queryId: 'q-harbor' }],
    })
  })

  it('names a location with every market that holds it, and no search location', () => {
    // Harbor Point sits in Uptown and Downtown, so the query counts in both.
    expect(sent(changeSubject(rows.market, { kind: 'location', key: 'harbor' }, workspace))).toStrictEqual({
      additions: [{ input: uptownText, audience: { targetKeys: ['harbor'], marketKeys: ['uptown', 'downtown'] } }],
      removals: [{ queryId: 'q-uptown' }],
    })
    expect(sent(changeSubject(rows.market, { kind: 'location', key: 'pier' }, workspace)).additions)
      .toStrictEqual([{ input: uptownText, audience: { targetKeys: ['pier'], marketKeys: ['solo'] } }])
  })

  it('names a location in no market alone, with the one search location chosen for it', () => {
    const chosen = contextChoices[1]!.input
    expect(sent(changeSubject(rows.market, { kind: 'location', key: 'lone' }, workspace, chosen))).toStrictEqual({
      additions: [{ input: uptownText, audience: { targetKeys: ['lone'] }, contexts: [chosen] }],
      removals: [{ queryId: 'q-uptown' }],
    })
    // Until one is chosen there is no request: the server would refuse a location outside a market without it.
    expect(changeSubject(rows.market, { kind: 'location', key: 'lone' }, workspace)).toBeNull()
    expect(moveLocation(rows.location, 'lone', workspace)).toBeNull()
    // A market or a location inside one takes its market's search locations, so a chosen one is not sent.
    expect(sent(changeSubject(rows.market, { kind: 'location', key: 'harbor' }, workspace, chosen)).additions[0]).not.toHaveProperty('contexts')
    expect(sent(changeSubject(rows.location, { kind: 'market', key: 'uptown' }, workspace, chosen)).additions[0]).not.toHaveProperty('contexts')
  })

  it('moves a location query to another location with the same one removal and one addition', () => {
    expect(sent(moveLocation(rows.location, 'river', workspace))).toStrictEqual({
      additions: [{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { targetKeys: ['river'], marketKeys: ['uptown'] } }],
      removals: [{ queryId: 'q-harbor' }],
    })
    expect(moveLocation(rows.location, 'river', workspace)).toStrictEqual(changeSubject(rows.location, { kind: 'location', key: 'river' }, workspace))
  })

  it('sends the type again only when an operator set every pairing to one type', () => {
    const toRiver = (row: TrackedRowVm) => sent(moveLocation(row, 'river', workspace)).additions[0]!
    expect(toRiver(rows.operatorSet).queryClass).toBe('non-brand')
    // The server chose this type, so it is left out and the server classifies for the new Subject.
    expect(toRiver(rows.location)).not.toHaveProperty('queryClass')

    const [first] = rows.operatorSet.tracked.assignments
    const withPairings = (assignments: TrackedRowVm['tracked']['assignments'], queryClasses = rows.operatorSet.queryClasses): TrackedRowVm =>
      ({ ...rows.operatorSet, queryClasses, tracked: { ...rows.operatorSet.tracked, assignments } })
    const elsewhere = { ...first!, targetKey: 'river' }
    expect(toRiver(withPairings([first!, elsewhere])).queryClass).toBe('non-brand')
    // One pairing the server chose, or a second type anywhere, and the operator did not set one type.
    expect(toRiver(withPairings([first!, { ...elsewhere, classificationSource: 'server' }]))).not.toHaveProperty('queryClass')
    expect(toRiver(withPairings([first!, { ...elsewhere, queryClass: 'branded' }], ['branded', 'non-brand']))).not.toHaveProperty('queryClass')
    // `assignments` lists one type per location; the row's types hold every search location's.
    expect(toRiver(withPairings([first!], ['branded', 'non-brand']))).not.toHaveProperty('queryClass')
    expect(toRiver(withPairings([{ ...first!, classificationSource: 'frozen' }]))).not.toHaveProperty('queryClass')
  })

  it('never sends an addition without the places it is for', () => {
    const targets = [{ kind: 'market', key: 'uptown' }, { kind: 'location', key: 'harbor' }, { kind: 'location', key: 'pier' }, { kind: 'location', key: 'lone' }] as const
    for (const target of targets) {
      for (const row of [rows.market, rows.location, rows.handPicked, rows.operatorSet]) {
        const { additions, removals } = sent(changeSubject(row, target, workspace, contextChoices[0]!.input))
        expect(removals).toStrictEqual([{ queryId: row.queryId }])
        expect(additions).toHaveLength(1)
        expect(Object.values(additions[0]!.audience ?? {}).flat().length, `${row.queryId} to ${target.key}`).toBeGreaterThan(0)
      }
    }
  })

  it('knows a change to the Subject the row already has', () => {
    expect(sameSubject(rows.market, { kind: 'market', key: 'uptown' })).toBe(true)
    expect(sameSubject(rows.market, { kind: 'market', key: 'downtown' })).toBe(false)
    // A market and a location can share a key.
    expect(sameSubject(rows.market, { kind: 'location', key: 'uptown' })).toBe(false)
    expect(sameSubject(rows.location, { kind: 'location', key: 'harbor' })).toBe(true)
    expect(sameSubject(rows.handPicked, { kind: 'market', key: 'uptown' })).toBe(false)
  })
})

describe('guards', () => {
  it('lets the type alone set the Subject only in a market of one location that sits nowhere else', () => {
    expect(typeSetsSubject({ kind: 'market', key: 'solo' }, workspace)).toBe(true)
    expect(typeSetsSubject({ kind: 'location', key: 'pier' }, workspace)).toBe(true)
    expect(typeSetsSubject({ kind: 'market', key: 'uptown' }, workspace)).toBe(false)
    // Downtown holds only Harbor Point, but Harbor Point also sits in Uptown: its own query names both markets.
    expect(typeSetsSubject({ kind: 'market', key: 'downtown' }, workspace)).toBe(false)
    expect(typeSetsSubject({ kind: 'location', key: 'harbor' }, workspace)).toBe(false)
    expect(typeSetsSubject({ kind: 'location', key: 'lone' }, workspace)).toBe(false)
    expect(typeSetsSubject({ kind: 'market', key: 'gone' }, workspace)).toBe(false)
    expect([rows.soloMarket, rows.soloLocation].map(row => rowTypeSetsSubject(row, workspace))).toEqual([true, true])
    expect([rows.market, rows.downtown, rows.location, rows.handPicked, rows.notAsked].map(row => rowTypeSetsSubject(row, workspace))).toEqual([false, false, false, false, false])
  })

  it('lists the markets that hold a location, in the workspace order, for each workspace it is given', () => {
    const labels = (key: string, from = workspace) => marketsHolding(from, key).map(market => market.label)
    expect(labels('harbor')).toEqual(['Uptown', 'Downtown'])
    expect(labels('pier')).toEqual(['Solo'])
    expect(labels('lone')).toEqual([])
    // Another workspace is read on its own, never from the first one's answer.
    const [uptown, ...others] = workspace.markets
    expect(labels('harbor', { ...workspace, markets: others })).toEqual(['Downtown'])
    expect(labels('river', { ...workspace, markets: [...others, uptown!] })).toEqual(['Uptown'])
    expect(labels('harbor')).toEqual(['Uptown', 'Downtown'])
  })

  it('offers a Subject change except where the type decides it', () => {
    expect(canChangeSubject(rows.market, workspace)).toBe(true)
    expect(canChangeSubject(rows.location, workspace)).toBe(true)
    expect(canChangeSubject(rows.downtown, workspace)).toBe(true)
    expect(canChangeSubject(rows.handPicked, workspace)).toBe(true)
    expect(canChangeSubject(rows.soloMarket, workspace)).toBe(false)
    expect(canChangeSubject(rows.soloLocation, workspace)).toBe(false)
    expect(canChangeSubject(rows.notAsked, workspace)).toBe(false)
    expect(canChangeSubject({ ...rows.market, subject: { kind: 'company' } }, workspace)).toBe(false)
  })

  it('offers each Subject its own type, and both where the Subject does not fix one', () => {
    expect(allowedTypes(rows.market, workspace)).toEqual(['auto', 'non-brand'])
    expect(allowedTypes(rows.downtown, workspace)).toEqual(['auto', 'non-brand'])
    expect(allowedTypes(rows.location, workspace)).toEqual(['auto', 'branded'])
    expect(allowedTypes(rows.handPicked, workspace)).toEqual(['auto', 'branded', 'non-brand'])
    expect(allowedTypes({ ...rows.market, subject: { kind: 'company' } }, workspace)).toEqual(['auto', 'branded', 'non-brand'])
    // In Solo the type is what moves a query between the market and its one location.
    expect(allowedTypes(rows.soloMarket, workspace)).toEqual(['auto', 'branded', 'non-brand'])
    expect(allowedTypes(rows.soloLocation, workspace)).toEqual(['auto', 'branded', 'non-brand'])
    // Among several rows it keeps its own type, so a bulk change moves no query to the other Subject.
    expect(allowedTypes(rows.soloMarket, workspace, true)).toEqual(['auto', 'non-brand'])
    expect(allowedTypes(rows.soloLocation, workspace, true)).toEqual(['auto', 'branded'])
    expect(allowedTypes(rows.handPicked, workspace, true)).toEqual(['auto', 'branded', 'non-brand'])
    // The server refuses any type for a query with no pairing, Automatic included.
    expect(allowedTypes(rows.notAsked, workspace)).toEqual([])
    expect(allowedTypes(rows.notAsked, workspace, true)).toEqual([])
  })

  it('skips the rows of a bulk type change that cannot take the type', () => {
    const selected = [rows.market, rows.marketB, rows.handPicked, rows.marketC]
    const { changed, skipped } = typeChangeRows(selected, 'branded', workspace)
    expect(changed).toEqual([rows.handPicked])
    expect(skipped).toEqual([rows.market, rows.marketB, rows.marketC])
    expect(typeChangeRows(selected, 'non-brand', workspace)).toEqual({ changed: selected, skipped: [] })
    expect(typeChangeRows([...selected, rows.location], 'auto', workspace).skipped).toEqual([])
    // A query that is not asked is skipped for every type, so one such row never has the whole change refused.
    expect(typeChangeRows([rows.market, rows.notAsked], 'auto', workspace)).toEqual({ changed: [rows.market], skipped: [rows.notAsked] })
  })

  it('moves no Subject in bulk: a one-location market row keeps its own type and is skipped for the other', () => {
    const selected = [rows.market, rows.soloMarket, rows.soloLocation, rows.handPicked]
    expect(typeChangeRows(selected, 'branded', workspace)).toEqual({ changed: [rows.soloLocation, rows.handPicked], skipped: [rows.market, rows.soloMarket] })
    expect(typeChangeRows(selected, 'non-brand', workspace)).toEqual({ changed: [rows.market, rows.soloMarket, rows.handPicked], skipped: [rows.soloLocation] })
    expect(typeChangeRows(selected, 'auto', workspace).skipped).toEqual([])
    // One row alone takes either: there the type is the only way to move it.
    expect(typeChangeRows([rows.soloMarket], 'branded', workspace)).toEqual({ changed: [rows.soloMarket], skipped: [] })
    expect(typeChangeRows([rows.soloLocation], 'non-brand', workspace)).toEqual({ changed: [rows.soloLocation], skipped: [] })
  })

  it('knows when a type would change nothing', () => {
    // The server chose this Non-brand: Automatic is what it has, and setting Non-brand makes it an operator's.
    expect(typeWouldChange(rows.market, 'auto')).toBe(false)
    expect(typeWouldChange(rows.market, 'non-brand')).toBe(true)
    // An operator set this Non-brand: Automatic hands it back, Non-brand is what it has.
    expect(typeWouldChange(rows.operatorSet, 'auto')).toBe(true)
    expect(typeWouldChange(rows.operatorSet, 'non-brand')).toBe(false)
    expect(typeWouldChange(rows.operatorSet, 'branded')).toBe(true)
    // No recorded source: the server classifies it again under Automatic.
    expect(typeWouldChange(withSource(rows.market, 'frozen'), 'auto')).toBe(true)
    // Asked from two search locations, the row shows only the first one's type and source: the server is asked.
    const twice = withSecondSearchLocation(rows.operatorSet)
    expect(typeWouldChange(twice, 'non-brand')).toBe(true)
    expect(typeWouldChange(withSecondSearchLocation(rows.location), 'auto')).toBe(true)
  })

  it('knows when narrowing a change to the place differs from the change everywhere', () => {
    const harbor: TrackedPlace = { kind: 'location', key: 'harbor', label: 'Harbor Point' }
    const north: TrackedPlace = { kind: 'group', key: 'north', label: 'North' }
    // Every pairing of an Uptown market query is in Uptown and in no other market.
    expect(reachesBeyond([rows.market, rows.marketB], uptownPlace)).toBe(false)
    // Harbor Point's own query is asked in Uptown and in Downtown; a hand-picked one also at Pier House, outside Uptown.
    expect(reachesBeyond([rows.location], uptownPlace)).toBe(true)
    expect(reachesBeyond([rows.handPicked], uptownPlace)).toBe(true)
    expect(reachesBeyond([rows.market, rows.handPicked], uptownPlace)).toBe(true)
    // In a market, a location asked from two search locations may be in it for only one of them.
    expect(reachesBeyond([withSecondSearchLocation(rows.market)], uptownPlace)).toBe(true)

    expect(reachesBeyond([rows.location, rows.operatorSet], harbor)).toBe(false)
    expect(reachesBeyond([withSecondSearchLocation(rows.location)], harbor)).toBe(false)
    expect(reachesBeyond([rows.market], harbor)).toBe(true)

    // Each location's groups, first location first: a location can sit in several.
    const grouped = (row: TrackedRowVm, first: string[], others = first): TrackedRowVm => ({ ...row, tracked: { ...row.tracked, assignments: row.tracked.assignments.map((pairing, index) => ({ ...pairing, groupKeys: index === 0 ? first : others })) } })
    expect(reachesBeyond([grouped(rows.market, ['north'])], north)).toBe(false)
    expect(reachesBeyond([grouped(rows.market, ['east', 'north'])], north)).toBe(false)
    expect(reachesBeyond([grouped(rows.market, ['east', 'north'], ['east'])], north)).toBe(true)
    expect(reachesBeyond([rows.market], north)).toBe(true)
    // A query that is not asked has nothing outside any place.
    expect(reachesBeyond([rows.notAsked], uptownPlace)).toBe(false)
  })
})

describe('rowMenuActions', () => {
  it.each([
    ['a market query', rows.market, ['edit-wording', 'change-subject', 'change-type', 'stop', 'copy-link']],
    ['a location query', rows.location, ['edit-wording', 'change-subject', 'move-location', 'change-type', 'stop', 'copy-link']],
    ['a hand-picked query', rows.handPicked, ['edit-wording', 'change-subject', 'change-type', 'stop', 'copy-link']],
    ['a market query where the type sets the Subject', rows.soloMarket, ['edit-wording', 'change-type', 'stop', 'copy-link']],
    ['a location query where the type sets the Subject', rows.soloLocation, ['edit-wording', 'move-location', 'change-type', 'stop', 'copy-link']],
    ['a query that is not asked', rows.notAsked, ['track', 'remove', 'copy-link']],
  ] as const)('gives a writer the actions of %s', (_name, row, actions) => {
    expect(rowMenuActions(row, workspace, true)).toEqual(actions)
  })

  it('gives a viewer only the link, whatever the row', () => {
    for (const row of Object.values(rows)) expect(rowMenuActions(row, workspace, false)).toEqual(['copy-link'])
  })
})
