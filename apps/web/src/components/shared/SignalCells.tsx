import { useTooltipBubble } from './InfoTooltip.js'

/**
 * One engine's result for one query: was the subject in the answer text, and
 * was it in the answer's sources. The two are separate signals and neither is
 * ever read from the other. `null` on a signal means not checked, never no.
 * The counts are the server's; without them the bubble says only the state.
 */
export interface EngineSignal {
  mentioned: boolean | null
  cited: boolean | null
  /** Answers the sweep asked this engine for. Fewer saved than asked is why a signal is not checked. */
  expectedAnswers?: number
  /** Answers saved for this engine, the base of both counts. */
  answers?: number
  mentionedAnswers?: number
  citedAnswers?: number
  /** Answers among them whose sources could not be checked. They are in neither side of the cited count, so the bubble says them after it. */
  uncheckedSourceAnswers?: number
  otherLocationMentionedAnswers?: number
  otherLocationCitedAnswers?: number
  /** With a comparison: the mention gained or lost since the previous sweep. */
  mentionChange?: 'won' | 'lost'
  /** The same for the citation. */
  citationChange?: 'won' | 'lost'
}

/** Research checks company names and the project domain, so its first chip is N (Named), not M (Mentioned). */
export type SignalVariant = 'tracked' | 'research'

type ChipState = 'yes' | 'no' | 'unchecked'
type SignalWords = { letter: string; yes: string; no: string; unchecked: string }

const FIRST: Record<SignalVariant, SignalWords> = {
  tracked: { letter: 'M', yes: 'Mentioned', no: 'Not mentioned', unchecked: 'Mention not checked' },
  research: { letter: 'N', yes: 'Named', no: 'Not named', unchecked: 'Name not checked' },
}
const CITED: SignalWords = { letter: 'C', yes: 'Cited', no: 'Not cited', unchecked: 'Citation not checked' }
const NOT_CHECKED = 'Not checked'

const CHIP = 'relative grid size-[19px] shrink-0 place-items-center rounded border text-[10.5px] font-semibold leading-none'
const CHIP_STATE: Record<ChipState | 'loading', string> = {
  yes: 'border-positive bg-positive-soft text-positive',
  no: 'border-strong text-faint',
  // Its dashes are all there is to see, so they are a step brighter than the box around a No.
  unchecked: 'border-dashed border-mono-500',
  loading: 'skeleton border-transparent',
}
// The pair is 19px tall. Where a finger is the pointer it takes taps on a 44px box.
const PAIR = 'inline-flex items-center justify-center gap-[3px] align-middle pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-md:min-h-11 max-md:min-w-11'

const stateOf = (value: boolean | null): ChipState => value === null ? 'unchecked' : value ? 'yes' : 'no'
const whole = (value: number) => value.toLocaleString('en-US')

/**
 * What one pair's bubble says of its result, a sentence each, and whether that
 * is more than the two states its name already carries. Each count is the
 * server's: "Mentioned in 2 of 3 answers. Cited in 0 of 3." The noun follows
 * the base and is said once, by the first sentence that holds a count. A
 * signal that came with no count, or no saved answer, gives its bare state.
 * One that is not checked says why where the read says it: `noResult` for a
 * query with no result at all, no answer saved, or sources partly saved.
 */
function resultSentences(first: SignalWords, mentioned: ChipState, cited: ChipState, signal: EngineSignal | null, noResult: string | undefined): { sentences: string[]; more: boolean } {
  if (signal === null) return { sentences: [noResult ?? `${NOT_CHECKED}.`], more: noResult !== undefined }
  const { answers, expectedAnswers } = signal
  // Asked for more answers than were saved: the rest are why a signal is not checked.
  const saved = answers !== undefined && expectedAnswers !== undefined && answers > 0 && answers < expectedAnswers && (mentioned === 'unchecked' || cited === 'unchecked')
    ? [`${whole(answers)} of ${whole(expectedAnswers)} answers saved.`]
    : []
  if (mentioned === 'unchecked' && cited === 'unchecked') {
    if (answers === 0 && (expectedAnswers ?? 0) > 0) return { sentences: ['No answer saved.'], more: true }
    return { sentences: [`${NOT_CHECKED}.`, ...saved], more: saved.length > 0 }
  }
  if (answers === undefined || answers === 0) return { sentences: [`${first[mentioned]}.`, `${CITED[cited]}.`], more: false }
  const mentionCount = mentioned === 'unchecked' ? undefined : signal.mentionedAnswers
  const citedCount = cited === 'unchecked' ? undefined : signal.citedAnswers
  const unchecked = signal.uncheckedSourceAnswers ?? 0
  const named = `${whole(answers)} ${answers === 1 ? 'answer' : 'answers'}`
  const sentences = [
    mentionCount === undefined ? `${first[mentioned]}.` : `${first.yes} in ${whole(mentionCount)} of ${named}.`,
    cited === 'unchecked' ? `${CITED.unchecked}${unchecked > 0 ? ': sources partly saved' : ''}.`
      : citedCount === undefined ? `${CITED[cited]}.`
        : `${CITED.yes} in ${whole(citedCount)} of ${mentionCount === undefined ? named : whole(answers)}.`,
  ]
  if (cited !== 'unchecked' && unchecked > 0) sentences.push(`${whole(unchecked)} had sources not checked.`)
  return { sentences: [...sentences, ...saved], more: mentionCount !== undefined || citedCount !== undefined || unchecked > 0 || saved.length > 0 }
}

/**
 * A No keeps its box and its letter and is struck through, so it differs from
 * a Yes by its shape and not only by its color. A not-checked chip is a
 * dashed box with no letter to see, so it never passes for a No. Its letter
 * stays in the box, unseen, as it does while loading, so every chip has the
 * same baseline and pairs line up however a row or a stack aligns them.
 */
function SignalChip({ state, letter, spoken = false }: { state: ChipState | 'loading'; letter: string; spoken?: boolean }) {
  return (
    <span aria-hidden={spoken ? undefined : true} className={`${CHIP} ${CHIP_STATE[state]}`}>
      <span className={state === 'yes' || state === 'no' ? undefined : 'invisible'}>{letter}</span>
      {state === 'no' ? (
        // Laid over the whole box, border included, in the letter's own color. The stroke stops short of the box's corners, so the letter under it still reads.
        <svg aria-hidden="true" viewBox="0 0 19 19" className="pointer-events-none absolute -inset-px size-[19px]">
          <line x1="4.5" y1="14.5" x2="14.5" y2="4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      ) : null}
    </span>
  )
}

/**
 * The two chips of one engine for one query: the first for the answer text
 * (M, or N in research), the second for its sources (C). Each is lit for yes,
 * struck through for no and a dashed empty box for not checked, read from its
 * own field. `signal` undefined is still loading and draws a skeleton; `null`
 * is a query with no result, so both chips are not checked. The pair is one
 * focus stop: its name says the engine and both states in words ("ChatGPT:
 * Mentioned, Not cited"), and its bubble says whose result it is (`subject`)
 * and the counts behind the states. The bubble is also its description
 * whenever it says more than the name does: a subject, a count, or why a
 * signal is not checked (`noResult` is the caller's sentence for a query with
 * no result, such as "Not in the last sweep."). Branded and non-brand results
 * are never combined, so a query asked both ways gets one pair per type, each
 * named by `classLabel`. A pair is one line of a fixed height (19px, 44px
 * where a finger is the pointer), so the pairs of a stack line up with labels
 * stacked beside them. A sheet focuses its first focusable control when it
 * opens, and focus opens the bubble: never put a pair first in a sheet.
 */
export function SignalPair({ signal, engineLabel, variant = 'tracked', classLabel, subject, noResult }: {
  signal: EngineSignal | null | undefined
  engineLabel: string
  variant?: SignalVariant
  classLabel?: string
  /** Whose mention or citation the pair is, as its bubble's opening sentence: "Harbor Point", "Any of 3 locations in Uptown". */
  subject?: string
  /** Why a query with no result has none, a sentence said in place of "Not checked.". */
  noResult?: string
}) {
  const first = FIRST[variant]
  if (signal === undefined) {
    return <span aria-hidden="true" className={PAIR}><SignalChip state="loading" letter={first.letter} /><SignalChip state="loading" letter={CITED.letter} /></span>
  }
  return <SignalPairButton signal={signal} engineLabel={engineLabel} first={first} classLabel={classLabel} subject={subject} noResult={noResult} />
}

/** Its own component, so a pair that goes back to loading never carries an open bubble across. */
function SignalPairButton({ signal, engineLabel, first, classLabel, subject, noResult }: {
  signal: EngineSignal | null
  engineLabel: string
  first: SignalWords
  classLabel: string | undefined
  subject: string | undefined
  noResult: string | undefined
}) {
  const mentioned = stateOf(signal?.mentioned ?? null)
  const cited = stateOf(signal?.cited ?? null)
  const states = mentioned === 'unchecked' && cited === 'unchecked' ? NOT_CHECKED : `${first[mentioned]}, ${CITED[cited]}`
  const result = resultSentences(first, mentioned, cited, signal, noResult)
  // The bubble is a list of sentences, in reading order: the type, whose result it is, then the result. A new fact is one more entry.
  // A name can end in a full stop of its own ("Harbor Point Apts.").
  const detail = [...[classLabel, subject].flatMap(lead => lead ? [lead.endsWith('.') ? lead : `${lead}.`] : []), ...result.sentences].join(' ')
  // Opens below: the placement that keeps the bubble inside a narrow viewport, wherever the cell sits.
  // Pairs fill a column, so a pointer on its way down it opens nothing until it rests on one.
  const bubble = useTooltipBubble(detail, { placement: 'bottom', hoverDelay: 300 })
  return <>
    <button
      type="button"
      className={`${PAIR} cursor-help rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
      aria-label={`${engineLabel}${classLabel ? `, ${classLabel}` : ''}: ${states}`}
      aria-description={subject || result.more ? detail : undefined}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      <SignalChip state={mentioned} letter={first.letter} />
      <SignalChip state={cited} letter={CITED.letter} />
    </button>
    {bubble.bubble}
  </>
}

const LEGEND_ITEM = 'inline-flex items-start gap-1.5'
// A company name or a domain can be longer than a phone is wide, so an entry that holds one wraps inside itself.
const LEGEND_NAMED = `${LEGEND_ITEM} max-w-full wrap-anywhere`
const LEGEND_WORD = `${LEGEND_ITEM} whitespace-nowrap`

/**
 * What the chips mean, beside the table that shows them: each state drawn as
 * a cell draws it, with its word. The research legend names what was checked:
 * the company's names and the project's domain.
 */
export function SignalLegend(props: { variant?: 'tracked' } | { variant: 'research'; company: string; domain: string }) {
  const first = FIRST[props.variant ?? 'tracked']
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] leading-5 text-secondary">
      {/* The space between a chip and its word is for a reader of the text; the gap draws it. */}
      <li className={LEGEND_NAMED}><SignalChip state="yes" letter={first.letter} spoken />{' '}{props.variant === 'research' ? `Names ${props.company}` : first.yes}</li>
      <li className={LEGEND_NAMED}><SignalChip state="yes" letter={CITED.letter} spoken />{' '}{props.variant === 'research' ? `Cites ${props.domain}` : CITED.yes}</li>
      <li className={LEGEND_WORD}><SignalChip state="no" letter={first.letter} spoken />{' '}{first.no}</li>
      <li className={LEGEND_WORD}><SignalChip state="no" letter={CITED.letter} spoken />{' '}{CITED.no}</li>
      <li className={LEGEND_WORD}><SignalChip state="unchecked" letter={first.letter} />{NOT_CHECKED}</li>
    </ul>
  )
}
