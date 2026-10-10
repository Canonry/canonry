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
  /** Answers saved for this engine, the base of both counts. */
  answers?: number
  mentionedAnswers?: number
  citedAnswers?: number
  /** Answers among them whose sources could not be checked. They are in neither side of the cited count, so the bubble says them after it. */
  uncheckedSourceAnswers?: number
}

/** Research checks company names and the project domain, so its first chip is N (Named), not M (Mentioned). */
export type SignalVariant = 'tracked' | 'research'

type ChipState = 'yes' | 'no' | 'unchecked'
type SignalWords = { letter: string; yes: string; no: string; unchecked: string; verbs: readonly [one: string, many: string] }

const FIRST: Record<SignalVariant, SignalWords> = {
  tracked: { letter: 'M', yes: 'Mentioned', no: 'Not mentioned', unchecked: 'Mention not checked', verbs: ['mentions', 'mention'] },
  research: { letter: 'N', yes: 'Named', no: 'Not named', unchecked: 'Name not checked', verbs: ['names', 'name'] },
}
const CITED: SignalWords = { letter: 'C', yes: 'Cited', no: 'Not cited', unchecked: 'Citation not checked', verbs: ['cites', 'cite'] }
const NOT_CHECKED = 'Not checked'

const CHIP = 'grid size-[19px] shrink-0 place-items-center rounded border text-[10.5px] font-semibold leading-none'
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
/** The verb agrees with the count: "1 of 3 answers mentions it", "2 of 3 answers mention it". */
const countSentence = (count: number, base: string, words: SignalWords) => `${whole(count)} of ${base} ${words.verbs[count === 1 ? 0 : 1]} it.`

/**
 * "2 of 3 answers mention it. 0 of 3 cite it." from the server's counts, and
 * whether it holds a count. A signal that is not checked, or came with no
 * count or no saved answer, gives its bare state. The second sentence says
 * "answers" only when the first gave no count.
 */
function signalDetail(first: SignalWords, mentioned: ChipState, cited: ChipState, signal: EngineSignal | null): { text: string; counted: boolean } {
  if (mentioned === 'unchecked' && cited === 'unchecked') return { text: `${NOT_CHECKED}.`, counted: false }
  const answers = signal?.answers
  if (answers === undefined || answers === 0) return { text: `${first[mentioned]}. ${CITED[cited]}.`, counted: false }
  const mentionCount = mentioned === 'unchecked' ? undefined : signal?.mentionedAnswers
  const citedCount = cited === 'unchecked' ? undefined : signal?.citedAnswers
  const unchecked = cited === 'unchecked' ? 0 : signal?.uncheckedSourceAnswers ?? 0
  const named = `${whole(answers)} ${answers === 1 ? 'answer' : 'answers'}`
  const sentences = [
    mentionCount === undefined ? `${first[mentioned]}.` : countSentence(mentionCount, named, first),
    citedCount === undefined ? `${CITED[cited]}.` : countSentence(citedCount, mentionCount === undefined ? named : whole(answers), CITED),
  ]
  if (unchecked > 0) sentences.push(`${whole(unchecked)} had sources not checked.`)
  return { text: sentences.join(' '), counted: mentionCount !== undefined || citedCount !== undefined || unchecked > 0 }
}

/**
 * A not-checked chip is a dashed box with no letter to see, so it never passes
 * for a grey No. Its letter stays in the box, unseen, as it does while loading,
 * so every chip has the same baseline and pairs line up however a row or a
 * stack aligns them.
 */
function SignalChip({ state, letter, spoken = false }: { state: ChipState | 'loading'; letter: string; spoken?: boolean }) {
  return (
    <span aria-hidden={spoken ? undefined : true} className={`${CHIP} ${CHIP_STATE[state]}`}>
      <span className={state === 'yes' || state === 'no' ? undefined : 'invisible'}>{letter}</span>
    </span>
  )
}

/**
 * The two chips of one engine for one query: the first for the answer text
 * (M, or N in research), the second for its sources (C). Each is lit for yes,
 * grey for no and a dashed empty box for not checked, read from its own field.
 * `signal` undefined is still loading and draws a skeleton; `null` is a query
 * with no result, so both chips are not checked. The pair is one focus stop:
 * its name says the engine and both states in words ("ChatGPT: Mentioned, Not
 * cited"), and its bubble gives the counts behind them, which are also its
 * description; with no count the bubble only repeats the states, so there is no
 * description. Branded and non-brand results are never combined, so a query
 * asked both ways gets one pair per type, each named by `classLabel`. A pair
 * is one line of a fixed height (19px, 44px where a finger is the pointer), so
 * the pairs of a stack line up with labels stacked beside them. A sheet
 * focuses its first focusable control when it opens, and focus opens the
 * bubble: never put a pair first in a sheet.
 */
export function SignalPair({ signal, engineLabel, variant = 'tracked', classLabel }: {
  signal: EngineSignal | null | undefined
  engineLabel: string
  variant?: SignalVariant
  classLabel?: string
}) {
  const first = FIRST[variant]
  if (signal === undefined) {
    return <span aria-hidden="true" className={PAIR}><SignalChip state="loading" letter={first.letter} /><SignalChip state="loading" letter={CITED.letter} /></span>
  }
  return <SignalPairButton signal={signal} engineLabel={engineLabel} first={first} classLabel={classLabel} />
}

/** Its own component, so a pair that goes back to loading never carries an open bubble across. */
function SignalPairButton({ signal, engineLabel, first, classLabel }: {
  signal: EngineSignal | null
  engineLabel: string
  first: SignalWords
  classLabel: string | undefined
}) {
  const mentioned = stateOf(signal?.mentioned ?? null)
  const cited = stateOf(signal?.cited ?? null)
  const states = mentioned === 'unchecked' && cited === 'unchecked' ? NOT_CHECKED : `${first[mentioned]}, ${CITED[cited]}`
  const counts = signalDetail(first, mentioned, cited, signal)
  const detail = classLabel ? `${classLabel}. ${counts.text}` : counts.text
  // Opens below: the placement that keeps the bubble inside a narrow viewport, wherever the cell sits.
  // Pairs fill a column, so a pointer on its way down it opens nothing until it rests on one.
  const bubble = useTooltipBubble(detail, { placement: 'bottom', hoverDelay: 300 })
  return <>
    <button
      type="button"
      className={`${PAIR} cursor-help rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
      aria-label={`${engineLabel}${classLabel ? `, ${classLabel}` : ''}: ${states}`}
      aria-description={counts.counted ? detail : undefined}
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
 * What the chips mean, beside the table that shows them. The research legend
 * names what was checked: the company's names and the project's domain.
 */
export function SignalLegend(props: { variant?: 'tracked' } | { variant: 'research'; company: string; domain: string }) {
  const first = FIRST[props.variant ?? 'tracked']
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] leading-5 text-secondary">
      {/* The space between a chip and its word is for a reader of the text; the gap draws it. */}
      <li className={LEGEND_NAMED}><SignalChip state="yes" letter={first.letter} spoken />{' '}{props.variant === 'research' ? `Names ${props.company}` : first.yes}</li>
      <li className={LEGEND_NAMED}><SignalChip state="yes" letter={CITED.letter} spoken />{' '}{props.variant === 'research' ? `Cites ${props.domain}` : CITED.yes}</li>
      <li className={LEGEND_WORD}><SignalChip state="no" letter={first.letter} />No</li>
      <li className={LEGEND_WORD}><SignalChip state="unchecked" letter={first.letter} />{NOT_CHECKED}</li>
    </ul>
  )
}
