import { describe, it, expect } from 'vitest'

import {
  KNOWN_MOVING_POINTER_MODEL_IDS,
  MODEL_POINTER_EVENTS,
  MODEL_POINTER_REGISTRY_CHECKED_THROUGH,
  buildModelChangeNotice,
  evaluateModelPointerExposure,
  isMovingPointerModelId,
  modelPointerChangeDisclosureSchema,
  modelPointerEventSchema,
  type ModelPointerChangeDisclosure,
  type ModelPointerExposure,
} from '../src/model-pointers.js'

// Real dates from the seeded registry. Named here so a test failure points at
// the registry entry it depends on rather than at a bare literal.
const CHAT_LATEST_UNCONFIRMED_REPOINT = '2026-05-28'
const CHAT_LATEST_REPOINT = '2026-06-24'
const CHAT_LATEST_INTRODUCED = '2026-05-05'
const GPT_53_REPOINT = '2026-03-16'

/** The common case: every id run for the whole period. */
function overWholePeriod(modelIds: string[], periodStart: string, periodEnd: string): ModelPointerExposure {
  return evaluateModelPointerExposure({
    exposures: modelIds.map(modelId => ({ modelId, firstSeen: periodStart, lastSeen: periodEnd })),
    periodStart,
    periodEnd,
  })
}

/** Narrows to the disclosed shape, failing loudly rather than returning undefined. */
function disclosed(exposure: ModelPointerExposure): ModelPointerChangeDisclosure {
  expect(exposure.status).not.toBe('not-exposed')
  return exposure as ModelPointerChangeDisclosure
}

/**
 * The sentence a reader would actually be shown for this exposure, as one
 * engine's worth of it. The disclosure itself carries only facts; the copy is
 * built by `buildModelChangeNotice`, so a test about wording has to go through
 * it rather than reading a field off the DTO.
 */
function noticeText(exposure: ModelPointerExposure): string {
  const notice = buildModelChangeNotice({ openai: disclosed(exposure) })
  expect(notice).not.toBeNull()
  return notice!.kind === 'no-known-change' ? `${notice!.text} ${notice!.detail}` : notice!.text
}

describe('the registry itself', () => {
  it('every seeded entry is a valid event', () => {
    for (const event of MODEL_POINTER_EVENTS) {
      expect(() => modelPointerEventSchema.parse(event)).not.toThrow()
    }
  })

  it('every seeded entry carries a source a maintainer can re-check', () => {
    for (const event of MODEL_POINTER_EVENTS) {
      expect(event.sourceUrl.startsWith('https://')).toBe(true)
      expect(event.note.trim().length).toBeGreaterThan(0)
    }
  })

  it('marks every id it has an event for as a moving pointer', () => {
    for (const event of MODEL_POINTER_EVENTS) {
      expect(isMovingPointerModelId(event.modelId)).toBe(true)
      expect(KNOWN_MOVING_POINTER_MODEL_IDS.has(event.modelId.toLowerCase())).toBe(true)
    }
  })

  it('holds no duplicate (model, date, kind) rows', () => {
    const keys = MODEL_POINTER_EVENTS.map(e => `${e.modelId}|${e.date}|${e.kind}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('claims to be checked through a date no earlier than its newest entry', () => {
    // A marker BEFORE the newest entry means someone edited one of the two and
    // not the other, and every disclosure would then be dated by a check that
    // demonstrably did not cover the list it is describing.
    expect(MODEL_POINTER_REGISTRY_CHECKED_THROUGH).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const event of MODEL_POINTER_EVENTS) {
      expect(event.date <= MODEL_POINTER_REGISTRY_CHECKED_THROUGH).toBe(true)
    }
  })

  it('records the only unambiguous chat-latest change as confirmed and the doubtful one as not', () => {
    // The 2026-05-28 changelog entry reuses the "Released" boilerplate of the
    // 2026-05-05 introduction instead of the "Updated" wording of 2026-06-24.
    // It may be a real change or a duplicated entry; the record does not say.
    const byDate = new Map(MODEL_POINTER_EVENTS
      .filter(e => e.modelId === 'chat-latest' && e.kind === 'repointed')
      .map(e => [e.date, e.confirmed]))
    expect(byDate.get(CHAT_LATEST_REPOINT)).toBe(true)
    expect(byDate.get(CHAT_LATEST_UNCONFIRMED_REPOINT)).toBe(false)
  })
})

describe('isMovingPointerModelId', () => {
  it('treats a pinned model id as not exposed', () => {
    expect(isMovingPointerModelId('gpt-5.6-terra')).toBe(false)
    expect(isMovingPointerModelId('gpt-5.4-2026-03-05')).toBe(false)
    expect(isMovingPointerModelId('gemini-3.5-flash')).toBe(false)
    expect(isMovingPointerModelId('claude-sonnet-5')).toBe(false)
  })

  it('treats a registered pointer as exposed regardless of casing or padding', () => {
    expect(isMovingPointerModelId('  Chat-Latest ')).toBe(true)
    expect(isMovingPointerModelId('CHATGPT-4O-LATEST')).toBe(true)
  })

  it('treats an UNREGISTERED -latest id as exposed', () => {
    // The registry rots; the suffix rule is what keeps a pointer shipped
    // tomorrow from being silently treated as a pinned model until someone
    // remembers to add it. Failing this open is the expensive direction.
    expect(KNOWN_MOVING_POINTER_MODEL_IDS.has('gpt-6-chat-latest')).toBe(false)
    expect(isMovingPointerModelId('gpt-6-chat-latest')).toBe(true)
    expect(isMovingPointerModelId('claude-opus-5-latest')).toBe(true)
  })

  it('ignores an empty or whitespace-only id', () => {
    expect(isMovingPointerModelId('')).toBe(false)
    expect(isMovingPointerModelId('   ')).toBe(false)
  })
})

describe('a period spanning one change', () => {
  const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-06-01', '2026-06-30'))

  it('discloses the change', () => {
    expect(disclosure.status).toBe('known-change')
    expect(disclosure.changeCount).toBe(1)
    expect(disclosure.unverifiedChangeCount).toBe(0)
    expect(disclosure.modelIds).toEqual(['chat-latest'])
    expect(disclosure.firstChangeDate).toBe(CHAT_LATEST_REPOINT)
    expect(disclosure.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('carries the event itself so a surface can word it and cite the source', () => {
    expect(disclosure.changes).toEqual([{
      modelId: 'chat-latest',
      date: CHAT_LATEST_REPOINT,
      confirmed: true,
      sourceUrl: expect.stringContaining('https://'),
    }])
  })

  it('names the date and says what it means for the number', () => {
    expect(noticeText(disclosure)).toBe(
      'The model behind ChatGPT was updated on 2026-06-24, inside this period.'
      + ' Some of the movement in these numbers may come from this update'
      + ' rather than from a real change in how AI answers about you, so compare periods carefully.',
    )
  })

  it('is a valid disclosure', () => {
    expect(() => modelPointerChangeDisclosureSchema.parse(disclosure)).not.toThrow()
  })
})

describe('a period spanning several changes', () => {
  const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-05-01', '2026-07-01'))

  it('counts both changes in range', () => {
    expect(disclosure.changeCount).toBe(2)
    expect(disclosure.firstChangeDate).toBe(CHAT_LATEST_UNCONFIRMED_REPOINT)
    expect(disclosure.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('does not count the day the id was introduced as a change', () => {
    // 2026-05-05 is inside this period. The id starting to exist is not the
    // model behind it changing, and no reporting period can straddle it.
    expect(CHAT_LATEST_INTRODUCED >= '2026-05-01' && CHAT_LATEST_INTRODUCED <= '2026-07-01').toBe(true)
    expect(disclosure.changeCount).toBe(2)
    expect(noticeText(disclosure)).not.toContain(CHAT_LATEST_INTRODUCED)
  })
})

describe('a period spanning no known change', () => {
  // Built per test, not once for the describe: this is the state a regression
  // collapses into `not-exposed`, and a shared const would abort the whole file
  // instead of failing the tests that name the behaviour.
  const quietPeriod = () => disclosed(overWholePeriod(['chat-latest'], '2026-06-01', '2026-06-20'))

  it('still says something: no known change is not the same as no exposure', () => {
    // The fail-safe. A stale list answers "we know of nothing" exactly like a
    // fresh one does, so this state has to be visible and dated rather than
    // collapsing into the silence a project on fixed ids gets.
    const disclosure = quietPeriod()
    expect(disclosure.status).toBe('no-known-change')
    expect(disclosure.changes).toEqual([])
    expect(disclosure.changeCount).toBe(0)
    expect(disclosure.modelIds).toEqual(['chat-latest'])
  })

  it('says how fresh the knowledge is instead of implying safety', () => {
    const disclosure = quietPeriod()
    expect(disclosure.knownGoodAsOf).toBe(MODEL_POINTER_REGISTRY_CHECKED_THROUGH)
    expect(disclosure.checkedThroughPeriodEnd).toBe(true)
    // The date has to reach a reader, not just the DTO. A record nobody has
    // updated produces this exact state, so the sentence says when we looked.
    expect(noticeText(disclosure)).toContain(
      `We last checked for model updates on ${MODEL_POINTER_REGISTRY_CHECKED_THROUGH}.`,
    )
    expect(() => modelPointerChangeDisclosureSchema.parse(disclosure)).not.toThrow()
  })

  it('says the same for a period entirely before the id existed', () => {
    expect(disclosed(overWholePeriod(['chat-latest'], '2026-01-01', '2026-01-31')).status).toBe('no-known-change')
  })

  it('says the same for a moving id the registry has no dates for at all', () => {
    // Exposed by the suffix rule, nothing known about it. Reporting this as
    // silence would be the exact failure: an unrecorded moving id would read
    // as a pinned model.
    const unknownId = disclosed(overWholePeriod(['gpt-6-chat-latest'], '2026-01-01', '2026-06-30'))
    expect(unknownId.status).toBe('no-known-change')
    expect(unknownId.modelIds).toEqual(['gpt-6-chat-latest'])
  })

  it('returns nothing at all when the period is inverted', () => {
    expect(evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: '2026-05-01', lastSeen: '2026-07-01' }],
      periodStart: '2026-07-01',
      periodEnd: '2026-05-01',
    }).status).toBe('not-exposed')
  })
})

describe('a period reaching past the day the list was last checked', () => {
  const periodEnd = '2026-12-31'
  const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-06-01', periodEnd))

  it('flags that the tail of the period was never checked', () => {
    expect(periodEnd > MODEL_POINTER_REGISTRY_CHECKED_THROUGH).toBe(true)
    expect(disclosure.checkedThroughPeriodEnd).toBe(false)
  })

  it('says so in the copy, so ignorance never reads as clearance', () => {
    expect(noticeText(disclosure)).toContain(
      `We last checked for model updates on ${MODEL_POINTER_REGISTRY_CHECKED_THROUGH},`
      + ' and this period runs past that date, so there may be later updates we do not know about.',
    )
  })

  it('says so in the middle state too', () => {
    const quietTail = disclosed(overWholePeriod(['gpt-6-chat-latest'], '2026-06-01', periodEnd))
    expect(quietTail.status).toBe('no-known-change')
    expect(quietTail.checkedThroughPeriodEnd).toBe(false)
    expect(noticeText(quietTail)).toContain(
      'and this period runs past that date, so there may be later updates we do not know about.',
    )
  })
})

describe('the change has to have happened while the project was running the id', () => {
  // The regression this suite exists for: the id set and the period were once
  // computed independently over the whole span and then crossed, so a project
  // that changed models mid-window was caveated for a change to a model it was
  // not running on the day it moved.

  it('says nothing about a change AFTER the project switched away from the id', () => {
    // Ran chat-latest until 2026-06-01, then moved to a pinned model for the
    // rest of the period. The 2026-06-24 change cannot have touched it.
    const exposure = evaluateModelPointerExposure({
      exposures: [
        { modelId: 'chat-latest', firstSeen: '2026-05-01', lastSeen: '2026-06-01' },
        { modelId: 'gpt-5.6-terra', firstSeen: '2026-06-02', lastSeen: '2026-07-15' },
      ],
      periodStart: '2026-05-01',
      periodEnd: '2026-07-15',
    })
    const disclosure = disclosed(exposure)
    expect(disclosure.changes.map(c => c.date)).toEqual([CHAT_LATEST_UNCONFIRMED_REPOINT])
    expect(noticeText(disclosure)).not.toContain(CHAT_LATEST_REPOINT)
  })

  it('says nothing about a change BEFORE the project switched to the id', () => {
    // The mirror case. Moved onto chat-latest on 2026-07-01, well after both
    // known changes, so its numbers cannot straddle either of them.
    const exposure = evaluateModelPointerExposure({
      exposures: [
        { modelId: 'gpt-5.6-terra', firstSeen: '2026-05-01', lastSeen: '2026-06-30' },
        { modelId: 'chat-latest', firstSeen: '2026-07-01', lastSeen: '2026-07-15' },
      ],
      periodStart: '2026-05-01',
      periodEnd: '2026-07-15',
    })
    expect(exposure.status).toBe('no-known-change')
  })

  it('counts a change dated exactly on the day the id was FIRST seen', () => {
    // The sweep that day may have run on either side of the swap.
    const exposure = evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: CHAT_LATEST_REPOINT, lastSeen: '2026-07-15' }],
      periodStart: '2026-05-01',
      periodEnd: '2026-07-15',
    })
    expect(disclosed(exposure).changes.map(c => c.date)).toEqual([CHAT_LATEST_REPOINT])
  })

  it('counts a change dated exactly on the day the id was LAST seen', () => {
    const exposure = evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: '2026-06-10', lastSeen: CHAT_LATEST_REPOINT }],
      periodStart: '2026-06-01',
      periodEnd: '2026-07-15',
    })
    expect(disclosed(exposure).changes.map(c => c.date)).toEqual([CHAT_LATEST_REPOINT])
  })

  it('excludes a change one day outside either end of the exposure', () => {
    const after = evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: '2026-06-25', lastSeen: '2026-07-15' }],
      periodStart: '2026-06-01',
      periodEnd: '2026-07-15',
    })
    expect(after.status).toBe('no-known-change')
    const before = evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: '2026-06-01', lastSeen: '2026-06-23' }],
      periodStart: '2026-06-01',
      periodEnd: '2026-07-15',
    })
    expect(before.status).toBe('no-known-change')
  })

  it('scores each id against its own exposure, not against the pooled span', () => {
    // gpt-5.3-chat-latest ran in early March, chat-latest from June. Pooling
    // their spans would hand each of them the other one's changes.
    const exposure = evaluateModelPointerExposure({
      exposures: [
        { modelId: 'gpt-5.3-chat-latest', firstSeen: '2026-03-01', lastSeen: '2026-03-10' },
        { modelId: 'chat-latest', firstSeen: '2026-06-01', lastSeen: '2026-06-30' },
      ],
      periodStart: '2026-03-01',
      periodEnd: '2026-06-30',
    })
    const disclosure = disclosed(exposure)
    // 2026-03-16 fell after gpt-5.3-chat-latest was dropped; 2026-06-24 fell
    // while chat-latest was running.
    expect(disclosure.changes.map(c => `${c.modelId}@${c.date}`)).toEqual([`chat-latest@${CHAT_LATEST_REPOINT}`])
    expect(noticeText(disclosure)).not.toContain(GPT_53_REPOINT)
    // Both ids are still reported as run — the project IS on moving ids.
    expect(disclosure.modelIds).toEqual(['chat-latest', 'gpt-5.3-chat-latest'])
  })

  it('compares calendar days, so a same-day sweep timestamp still counts', () => {
    const exposure = evaluateModelPointerExposure({
      exposures: [{
        modelId: 'chat-latest',
        firstSeen: `${CHAT_LATEST_REPOINT}T08:00:00.000Z`,
        lastSeen: `${CHAT_LATEST_REPOINT}T23:59:59.000Z`,
      }],
      periodStart: `${CHAT_LATEST_REPOINT}T08:00:00.000Z`,
      periodEnd: `${CHAT_LATEST_REPOINT}T23:59:59.000Z`,
    })
    expect(disclosed(exposure).changeCount).toBe(1)
  })

  it('never reaches outside the reporting period even if an exposure does', () => {
    // The period is the contract with the number on screen. A caller passing a
    // wider exposure must not widen the caveat past what the metrics cover.
    const exposure = evaluateModelPointerExposure({
      exposures: [{ modelId: 'chat-latest', firstSeen: '2026-05-01', lastSeen: '2026-07-15' }],
      periodStart: '2026-06-01',
      periodEnd: '2026-06-20',
    })
    expect(exposure.status).toBe('no-known-change')
  })
})

describe('projects that are not exposed', () => {
  it('says nothing for a project on pinned model ids, even across a change date', () => {
    // The whole point: a project on a pinned id is unaffected by a re-point and
    // must never be handed a caveat about someone else's model.
    expect(overWholePeriod(['gpt-5.6-terra', 'gemini-3.5-flash', 'claude-sonnet-5'], '2026-01-01', '2026-12-31'))
      .toEqual({ status: 'not-exposed' })
  })

  it('says nothing for a project with no model ids at all', () => {
    expect(overWholePeriod([], '2026-01-01', '2026-12-31').status).toBe('not-exposed')
    expect(overWholePeriod(['', '  '], '2026-01-01', '2026-12-31').status).toBe('not-exposed')
  })

  it('ignores the pinned ids and reports only the exposed one', () => {
    const disclosure = disclosed(overWholePeriod(
      ['gemini-3.5-flash', 'chat-latest', 'gpt-5.6-terra'], '2026-06-01', '2026-06-30',
    ))
    expect(disclosure.modelIds).toEqual(['chat-latest'])
  })
})

describe('an unconfirmed change is never asserted and never dropped', () => {
  it('hedges when every change in range is unconfirmed', () => {
    const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-05-20', '2026-06-01'))
    expect(disclosure.changeCount).toBe(1)
    expect(disclosure.unverifiedChangeCount).toBe(1)
    expect(noticeText(disclosure)).toBe(
      'The model behind ChatGPT may have been updated on 2026-05-28, inside this period,'
      + ' though that is not confirmed.'
      + ' If so, some of the movement in these numbers may come from this update'
      + ' rather than from a real change in how AI answers about you, so compare periods carefully.',
    )
  })

  it('states the confirmed change and hedges the unconfirmed one separately', () => {
    // The defect this replaces: pooling them said "changed more than once,
    // between 2026-05-28 and 2026-06-24", which asserts a date the record does
    // not support — on exactly the window a client on chat-latest reads today.
    const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-05-01', '2026-07-01'))
    expect(disclosure.changeCount).toBe(2)
    expect(disclosure.unverifiedChangeCount).toBe(1)
    expect(noticeText(disclosure)).toBe(
      'The model behind ChatGPT was updated on 2026-06-24, inside this period,'
      + ' and may also have been updated on 2026-05-28.'
      + ' Some of the movement in these numbers may come from these updates'
      + ' rather than from a real change in how AI answers about you, so compare periods carefully.',
    )
    expect(noticeText(disclosure)).not.toContain('more than once')
  })

  it('keeps the unconfirmed event in the list with its own flag', () => {
    const disclosure = disclosed(overWholePeriod(['chat-latest'], '2026-05-01', '2026-07-01'))
    expect(disclosure.changes.map(c => [c.date, c.confirmed])).toEqual([
      [CHAT_LATEST_UNCONFIRMED_REPOINT, false],
      [CHAT_LATEST_REPOINT, true],
    ])
  })

  it('says "more than once" only about changes the record actually supports', () => {
    const disclosure = disclosed(overWholePeriod(['chat-latest', 'gpt-5.3-chat-latest'], '2026-01-01', '2026-07-01'))
    expect(noticeText(disclosure)).toContain(
      `was updated more than once between ${GPT_53_REPOINT} and ${CHAT_LATEST_REPOINT}`,
    )
    expect(noticeText(disclosure)).toContain(`may also have been updated on ${CHAT_LATEST_UNCONFIRMED_REPOINT}`)
  })
})

describe('several exposed ids at once', () => {
  it('pools the ids that changed and reports the outer dates', () => {
    const disclosure = disclosed(overWholePeriod(['gpt-5.3-chat-latest', 'chat-latest'], '2026-01-01', '2026-07-01'))
    expect(disclosure.modelIds).toEqual(['chat-latest', 'gpt-5.3-chat-latest'])
    // gpt-5.3-chat-latest once, chat-latest twice.
    expect(disclosure.changeCount).toBe(3)
    expect(disclosure.firstChangeDate).toBe(GPT_53_REPOINT)
    expect(disclosure.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
    // The ids are pooled as FACTS on the DTO; the sentence a reader sees names
    // the engine, never the model ids, so both must hold at once.
    expect(noticeText(disclosure)).toContain('The model behind ChatGPT')
    expect(noticeText(disclosure)).not.toContain('chat-latest')
  })
})

/**
 * The rendering the dashboard and the CLI both call. It lives here so the two
 * surfaces cannot word the same warning differently, and it is tested here
 * rather than in either of them for the same reason: an earlier cut of this
 * feature had a renderer in contracts that nothing called and a near-identical
 * copy pasted into each surface, which is three wordings of one warning and one
 * edit away from a client being told something softer on the dashboard than in
 * the terminal.
 *
 * Every sentence a reader can be shown is pinned as a literal. The same
 * sentences are asserted end-to-end through the DOM in
 * `apps/web/test/visibility-trend-section.test.tsx` and through stdout in
 * `packages/canonry/test/analytics.test.ts`.
 */
describe('buildModelChangeNotice', () => {
  const CLOSE = 'rather than from a real change in how AI answers about you, so compare periods carefully.'
  const confirmed = (date: string) => ({
    modelIds: ['chat-latest'],
    changeCount: 1,
    unverifiedChangeCount: 0,
    firstChangeDate: date,
    lastChangeDate: date,
  })

  it('says nothing when the server omits the field or the project runs fixed model ids', () => {
    expect(buildModelChangeNotice(undefined)).toBeNull()
    expect(buildModelChangeNotice({})).toBeNull()
  })

  it('names the engine the reader knows, not the model id, and scopes the caveat to every plotted number', () => {
    const notice = buildModelChangeNotice({ openai: confirmed('2026-06-24') })
    expect(notice).toEqual({
      kind: 'change',
      text: 'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
        + `Some of the movement in these numbers may come from this update ${CLOSE}`,
    })
    // The internal id is what the notice must NOT lead with: an agency owner
    // cannot map "chat-latest" onto a line of a chart.
    expect(notice!.text).not.toContain('chat-latest')
    expect(notice!.text).not.toContain('this number ')
  })

  /**
   * Two affected engines are two FACTS and one warning. A per-engine sentence
   * that bundles the consequence prints "part of any movement in this number
   * comes from that change" a second time on the same surface.
   */
  it('states one fact per engine and closes with exactly one consequence', () => {
    const notice = buildModelChangeNotice({
      openai: confirmed('2026-06-24'),
      perplexity: confirmed('2026-06-10'),
    })!
    expect(notice.text).toBe(
      'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
      + 'The model behind Perplexity was updated on 2026-06-10, inside this period. '
      + `Some of the movement in these numbers may come from these updates ${CLOSE}`,
    )
    const sentences = notice.text.split('. ').map(s => s.trim())
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('reports several updates on one engine as a range, not a change log', () => {
    expect(buildModelChangeNotice({
      gemini: { changeCount: 2, unverifiedChangeCount: 0, firstChangeDate: '2026-06-02', lastChangeDate: '2026-06-30' },
    })!.text).toBe(
      'The model behind Gemini was updated more than once between 2026-06-02 and 2026-06-30, inside this period. '
      + `Some of the movement in these numbers may come from these updates ${CLOSE}`,
    )
  })

  it('never asserts an unconfirmed update as fact, and never hides it either', () => {
    const notice = buildModelChangeNotice({
      openai: { changeCount: 1, unverifiedChangeCount: 1, firstChangeDate: '2026-05-28', lastChangeDate: '2026-05-28' },
    })!
    expect(notice.text).toBe(
      'The model behind ChatGPT may have been updated on 2026-05-28, inside this period, though that is not confirmed. '
      + `If so, some of the movement in these numbers may come from this update ${CLOSE}`,
    )
    expect(notice.text).not.toContain('was updated')
  })

  it('separates a confirmed update from an unconfirmed one when the server dates them', () => {
    expect(buildModelChangeNotice({
      openai: {
        changeCount: 2,
        unverifiedChangeCount: 1,
        firstChangeDate: '2026-05-28',
        lastChangeDate: '2026-06-24',
        changes: [{ date: '2026-05-28', confirmed: false }, { date: '2026-06-24', confirmed: true }],
      },
    })!.text).toBe(
      'The model behind ChatGPT was updated on 2026-06-24, inside this period, and may also have been updated on 2026-05-28. '
      + `Some of the movement in these numbers may come from these updates ${CLOSE}`,
    )
  })

  it('drops the dates rather than attach one to the wrong claim when confidence is mixed and undated', () => {
    expect(buildModelChangeNotice({
      openai: { changeCount: 2, unverifiedChangeCount: 1, firstChangeDate: '2026-05-28', lastChangeDate: '2026-06-24' },
    })!.text).toBe(
      'The model behind ChatGPT was updated inside this period, and may have been updated once more, though that is not confirmed. '
      + `Some of the movement in these numbers may come from these updates ${CLOSE}`,
    )
  })

  /**
   * The middle state. An engine that CAN be moved onto a different model with
   * nothing on record must not render as silence — silence is exactly what a
   * record nobody has updated in six months also produces.
   */
  it('says so out loud when an engine can be updated but nothing is on record', () => {
    const notice = buildModelChangeNotice({ openai: { changeCount: 0, unverifiedChangeCount: 0 } })!
    expect(notice.kind).toBe('no-known-change')
    expect(notice.text).toBe('No model updates are on record for ChatGPT in this period.')
    expect(buildModelChangeNotice({
      openai: { changeCount: 0 }, gemini: { changeCount: 0 },
    })!.text).toBe('No model updates are on record for ChatGPT and Gemini in this period.')
  })

  it('drops the quiet line when any engine actually changed, so the caveat stands alone', () => {
    const notice = buildModelChangeNotice({ openai: confirmed('2026-06-24'), gemini: { changeCount: 0 } })!
    expect(notice.kind).toBe('change')
    expect(notice.text).not.toContain('No model updates are on record')
    expect(notice.text).not.toContain('Gemini')
  })

  /**
   * The freshness of the record is the whole reason the quiet state is a state
   * rather than an absence, and it only does any work if it reaches a reader.
   * These are the tests that would have caught the server computing
   * `knownGoodAsOf` while every surface rendered a sentence without it.
   */
  describe('how recently the record was checked', () => {
    it('states the date whenever the server sends it', () => {
      const notice = buildModelChangeNotice({
        openai: { changeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: true },
      })!
      expect(notice.kind).toBe('no-known-change')
      expect(notice).toHaveProperty('detail')
      expect((notice as { detail: string }).detail)
        .toContain('We last checked for model updates on 2026-07-20.')
    })

    it('says the tail of the period was never checked, so ignorance cannot read as clearance', () => {
      const notice = buildModelChangeNotice({
        openai: { changeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false },
      })!
      const detail = (notice as { detail: string }).detail
      expect(detail).toContain(
        'We last checked for model updates on 2026-07-20, and this period runs past that date,'
        + ' so there may be later updates we do not know about.',
      )
      // Not both sentences: naming the same date twice reads as two findings.
      expect(detail).not.toContain('on 2026-07-20. ')
    })

    it('warns about the unchecked tail on a KNOWN change too', () => {
      // "We found one" must never imply "we found all of them".
      const notice = buildModelChangeNotice({
        openai: { ...confirmed('2026-06-24'), knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false },
      })!
      expect(notice.text).toContain(
        'We last checked for model updates on 2026-07-20, and this period runs past that date,'
        + ' so there may be later updates we do not know about.',
      )
    })

    it('quotes the OLDEST check when engines disagree, so the weakest knowledge bounds the claim', () => {
      const notice = buildModelChangeNotice({
        openai: { changeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false },
        gemini: { changeCount: 0, knownGoodAsOf: '2026-03-01', checkedThroughPeriodEnd: false },
      })!
      expect((notice as { detail: string }).detail).toContain('on 2026-03-01,')
      expect((notice as { detail: string }).detail).not.toContain('2026-07-20')
    })

    it('claims no freshness at all when an older server omits the date', () => {
      // Falling back to this build's own constant would assert a check the
      // server never performed, which is the lie the field exists to prevent.
      const notice = buildModelChangeNotice({ openai: { changeCount: 0 } })!
      expect((notice as { detail: string }).detail).not.toContain('last checked')
      expect((notice as { detail: string }).detail).not.toContain(MODEL_POINTER_REGISTRY_CHECKED_THROUGH)
    })
  })
})

describe('operator-facing copy stays plain', () => {
  const BANNED = ['pointer', 'alias', 'snapshot', 'drift', 'attribution', 'divergence', 'slug', 'repoint']

  it('never uses internal vocabulary in any sentence, in any state', () => {
    const periods: Array<[string, string]> = [
      ['2026-06-01', '2026-06-30'],
      ['2026-05-01', '2026-07-01'],
      ['2026-05-20', '2026-06-01'],
      ['2026-01-01', '2026-12-31'],
      // The quiet states, which the fail-safe renders too.
      ['2026-06-01', '2026-06-20'],
      ['2026-01-01', '2026-01-31'],
    ]
    for (const [start, end] of periods) {
      const exposure = overWholePeriod(['chat-latest', 'gpt-5.3-chat-latest'], start, end)
      const text = noticeText(exposure).toLowerCase()
      for (const word of BANNED) expect(text).not.toContain(word)
      // Em-dashes are banned in human-facing copy repo-wide.
      expect(text).not.toContain('\u2014')
    }
  })

  it('never leaks a raw model id into a sentence, in any state', () => {
    // The registry is keyed by model id and the DTO carries them; the reader is
    // shown an engine. `-latest` appearing in the copy means an id escaped.
    for (const [start, end] of [['2026-06-01', '2026-06-30'], ['2026-01-01', '2026-01-31']] as const) {
      expect(noticeText(overWholePeriod(['chat-latest', 'gpt-5.3-chat-latest'], start, end)))
        .not.toContain('-latest')
    }
  })
})
