import { describe, it, expect } from 'vitest'

import {
  KNOWN_MOVING_POINTER_MODEL_IDS,
  MODEL_CHANGE_NEXT_ACTION,
  MODEL_POINTER_EVENTS,
  findModelPointerChanges,
  formatModelChangeDisclosure,
  isMovingPointerModelId,
  modelPointerChangeDisclosureSchema,
  modelPointerEventSchema,
  type ModelPointerChangeDisclosure,
} from '../src/model-pointers.js'

// Real dates from the seeded registry. Named here so a test failure points at
// the registry entry it depends on rather than at a bare literal.
const CHAT_LATEST_UNCONFIRMED_REPOINT = '2026-05-28'
const CHAT_LATEST_REPOINT = '2026-06-24'
const CHAT_LATEST_INTRODUCED = '2026-05-05'
const GPT_53_REPOINT = '2026-03-16'

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

describe('findModelPointerChanges — a period spanning one change', () => {
  const disclosure = findModelPointerChanges({
    modelIds: ['chat-latest'],
    start: '2026-06-01',
    end: '2026-06-30',
  })

  it('discloses the change', () => {
    expect(disclosure).toBeDefined()
    expect(disclosure!.changeCount).toBe(1)
    expect(disclosure!.unverifiedChangeCount).toBe(0)
    expect(disclosure!.modelIds).toEqual(['chat-latest'])
    expect(disclosure!.firstChangeDate).toBe(CHAT_LATEST_REPOINT)
    expect(disclosure!.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('names the date and says what it means for the number', () => {
    expect(disclosure!.summary).toBe(
      'The model behind "chat-latest" changed on 2026-06-24, inside this reporting period.'
      + ' Part of any movement in this number comes from that change and not from how often AI names you.',
    )
  })

  it('is a valid disclosure', () => {
    expect(() => modelPointerChangeDisclosureSchema.parse(disclosure)).not.toThrow()
  })
})

describe('findModelPointerChanges — a period spanning several changes', () => {
  const disclosure = findModelPointerChanges({
    modelIds: ['chat-latest'],
    start: '2026-05-01',
    end: '2026-07-01',
  })

  it('counts both changes in range', () => {
    expect(disclosure!.changeCount).toBe(2)
    expect(disclosure!.firstChangeDate).toBe(CHAT_LATEST_UNCONFIRMED_REPOINT)
    expect(disclosure!.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('does not count the day the id was introduced as a change', () => {
    // 2026-05-05 is inside this period. The id starting to exist is not the
    // model behind it changing, and no reporting period can straddle it.
    expect(CHAT_LATEST_INTRODUCED >= '2026-05-01' && CHAT_LATEST_INTRODUCED <= '2026-07-01').toBe(true)
    expect(disclosure!.changeCount).toBe(2)
  })

  it('says "more than once" with the outer dates instead of listing every date', () => {
    expect(disclosure!.summary).toBe(
      'The model behind "chat-latest" changed more than once in this reporting period,'
      + ' between 2026-05-28 and 2026-06-24.'
      + ' Part of any movement in this number comes from those changes and not from how often AI names you.',
    )
    expect(disclosure!.summary).not.toContain('2026-05-05')
  })
})

describe('findModelPointerChanges — a period spanning no changes', () => {
  it('returns nothing for a quiet period on an exposed id', () => {
    // A project genuinely running chat-latest, but between the known changes.
    expect(findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-06-01',
      end: '2026-06-20',
    })).toBeUndefined()
  })

  it('returns nothing for a period entirely before the id existed', () => {
    expect(findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-01-01',
      end: '2026-01-31',
    })).toBeUndefined()
  })

  it('returns nothing when the period is inverted', () => {
    expect(findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-07-01',
      end: '2026-05-01',
    })).toBeUndefined()
  })
})

describe('findModelPointerChanges — boundaries are inclusive', () => {
  it('counts a change dated exactly on the period START', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: CHAT_LATEST_REPOINT,
      end: '2026-07-15',
    })
    expect(disclosure?.changeCount).toBe(1)
    expect(disclosure?.firstChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('counts a change dated exactly on the period END', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-06-10',
      end: CHAT_LATEST_REPOINT,
    })
    expect(disclosure?.changeCount).toBe(1)
    expect(disclosure?.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
  })

  it('excludes a change one day outside either end', () => {
    expect(findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-06-25',
      end: '2026-07-15',
    })).toBeUndefined()
    expect(findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-06-10',
      end: '2026-06-23',
    })).toBeUndefined()
  })

  it('compares calendar days, so a same-day sweep timestamp still counts', () => {
    // The period bounds are real sweep instants. A sweep at 08:00 on the change
    // date may have run on either side of the swap, so the day counts.
    const disclosure = findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: `${CHAT_LATEST_REPOINT}T08:00:00.000Z`,
      end: `${CHAT_LATEST_REPOINT}T23:59:59.000Z`,
    })
    expect(disclosure?.changeCount).toBe(1)
  })
})

describe('findModelPointerChanges — projects that are not exposed', () => {
  it('says nothing for a project on pinned model ids, even across a change date', () => {
    // The whole point: a project on a pinned id is unaffected by a re-point and
    // must never be handed a caveat about someone else's model.
    expect(findModelPointerChanges({
      modelIds: ['gpt-5.6-terra', 'gemini-3.5-flash', 'claude-sonnet-5'],
      start: '2026-01-01',
      end: '2026-12-31',
    })).toBeUndefined()
  })

  it('says nothing for a project with no model ids at all', () => {
    expect(findModelPointerChanges({ modelIds: [], start: '2026-01-01', end: '2026-12-31' })).toBeUndefined()
    expect(findModelPointerChanges({ modelIds: ['', '  '], start: '2026-01-01', end: '2026-12-31' })).toBeUndefined()
  })

  it('says nothing for a pointer the registry has no change for yet', () => {
    // Exposed by the suffix rule, but nothing is known to have happened to it —
    // "we have no dates" must read as no caveat, not as a change.
    expect(findModelPointerChanges({
      modelIds: ['gpt-6-chat-latest'],
      start: '2026-01-01',
      end: '2026-12-31',
    })).toBeUndefined()
  })

  it('ignores the pinned ids and reports only the exposed one', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['gemini-3.5-flash', 'chat-latest', 'gpt-5.6-terra'],
      start: '2026-06-01',
      end: '2026-06-30',
    })
    expect(disclosure?.modelIds).toEqual(['chat-latest'])
  })
})

describe('findModelPointerChanges — unverified changes hedge instead of asserting', () => {
  it('says "may have changed" when every change in range is unverified', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-05-20',
      end: '2026-06-01',
    })
    expect(disclosure!.changeCount).toBe(1)
    expect(disclosure!.unverifiedChangeCount).toBe(1)
    expect(disclosure!.summary).toBe(
      'The model behind "chat-latest" may have changed on 2026-05-28, inside this reporting period.'
      + ' If it did, part of any movement in this number comes from that change'
      + ' and not from how often AI names you.',
    )
  })

  it('asserts plainly when at least one change in range is confirmed', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['chat-latest'],
      start: '2026-05-20',
      end: '2026-07-01',
    })
    expect(disclosure!.unverifiedChangeCount).toBe(1)
    expect(disclosure!.changeCount).toBe(2)
    expect(disclosure!.summary).toContain('changed more than once')
    expect(disclosure!.summary).not.toContain('may have')
  })
})

describe('findModelPointerChanges — several exposed ids at once', () => {
  it('pools the ids and reports the outer dates', () => {
    const disclosure = findModelPointerChanges({
      modelIds: ['gpt-5.3-chat-latest', 'chat-latest'],
      start: '2026-01-01',
      end: '2026-12-31',
    })
    expect(disclosure!.modelIds).toEqual(['chat-latest', 'gpt-5.3-chat-latest'])
    // gpt-5.3-chat-latest once, chat-latest twice.
    expect(disclosure!.changeCount).toBe(3)
    expect(disclosure!.firstChangeDate).toBe(GPT_53_REPOINT)
    expect(disclosure!.lastChangeDate).toBe(CHAT_LATEST_REPOINT)
    expect(disclosure!.summary).toContain('The model behind "chat-latest" and "gpt-5.3-chat-latest"')
  })
})

/**
 * The rendering the dashboard and the CLI both call. It lives here so the two
 * surfaces cannot word the same warning differently, and it is tested here
 * rather than in either of them for the same reason.
 */
describe('formatModelChangeDisclosure', () => {
  const openai: ModelPointerChangeDisclosure = {
    modelIds: ['chat-latest'],
    changeCount: 1,
    unverifiedChangeCount: 0,
    firstChangeDate: '2026-06-24',
    lastChangeDate: '2026-06-24',
    summary: 'The model behind "chat-latest" changed on 2026-06-24, inside this reporting period.'
      + ' Part of any movement in this number comes from that change and not from how often AI names you.',
  }

  const gemini: ModelPointerChangeDisclosure = {
    modelIds: ['gemini-flash-latest'],
    changeCount: 2,
    unverifiedChangeCount: 0,
    firstChangeDate: '2026-06-02',
    lastChangeDate: '2026-06-30',
    summary: 'The model behind "gemini-flash-latest" changed more than once in this reporting period,'
      + ' between 2026-06-02 and 2026-06-30.'
      + ' Part of any movement in this number comes from those changes and not from how often AI names you.',
  }

  it('says nothing when there is nothing to say', () => {
    // An older server omits the field; a project on fixed model ids sends {}.
    expect(formatModelChangeDisclosure(undefined)).toBeNull()
    expect(formatModelChangeDisclosure({})).toBeNull()
  })

  it('renders the disclosure verbatim and closes with the next action', () => {
    expect(formatModelChangeDisclosure({ openai })).toBe(
      'The model behind "chat-latest" changed on 2026-06-24, inside this reporting period.'
      + ' Part of any movement in this number comes from that change and not from how often AI names you.'
      + ' Compare this period with earlier ones carefully.',
    )
  })

  it('states every affected engine in a stable order, and closes only once', () => {
    const note = formatModelChangeDisclosure({ openai, gemini })!
    expect(note).toBe(`${gemini.summary} ${openai.summary} ${MODEL_CHANGE_NEXT_ACTION}`)
    // One closing line however many engines are affected — repeating it would
    // read as two separate warnings about the same number.
    expect(note.split(MODEL_CHANGE_NEXT_ACTION)).toHaveLength(2)
  })

  it('drops an entry with no usable sentence instead of rendering a half-stated caveat', () => {
    expect(formatModelChangeDisclosure({ gemini: { ...gemini, summary: '   ' }, openai }))
      .toBe(`${openai.summary} ${MODEL_CHANGE_NEXT_ACTION}`)
    expect(formatModelChangeDisclosure({ gemini: { ...gemini, summary: '  ' } })).toBeNull()
  })
})

describe('operator-facing copy stays plain', () => {
  const BANNED = ['pointer', 'alias', 'snapshot', 'drift', 'attribution', 'divergence', 'slug', 'repoint']

  it('never uses internal vocabulary in the closing action', () => {
    for (const word of BANNED) expect(MODEL_CHANGE_NEXT_ACTION.toLowerCase()).not.toContain(word)
  })

  it('never uses internal vocabulary in a summary', () => {
    const periods: Array<[string, string]> = [
      ['2026-06-01', '2026-06-30'],
      ['2026-05-01', '2026-07-01'],
      ['2026-05-20', '2026-06-01'],
      ['2026-01-01', '2026-12-31'],
    ]
    for (const [start, end] of periods) {
      const disclosure = findModelPointerChanges({
        modelIds: ['chat-latest', 'gpt-5.3-chat-latest'],
        start,
        end,
      })
      expect(disclosure).toBeDefined()
      const summary = disclosure!.summary.toLowerCase()
      for (const word of BANNED) expect(summary).not.toContain(word)
    }
  })
})
