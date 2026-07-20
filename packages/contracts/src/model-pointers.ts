import { z } from 'zod'

import { formatIsoDate } from './formatting.js'

/**
 * KNOWN MODEL-POINTER EVENTS — a hand-maintained record of the dates on which a
 * provider changed the model sitting behind a moving model id.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Some provider model ids are not models. `chat-latest` names "whatever model
 * ChatGPT is currently using", and the provider re-points it whenever the
 * consumer product changes. A sweep cannot see the swap: the API echoes the
 * same id back on both sides of it, so a client's mention share can move
 * because the model changed, and that is indistinguishable from the client's
 * own position moving. Everything here exists so a number whose reporting
 * period spans a known change can carry an honest caveat.
 *
 * WHERE THE DATES COME FROM
 * -------------------------
 * The provider's own public changelog and deprecation pages (`sourceUrl` on
 * every entry). Those pages announce only THAT the model behind an id changed —
 * they never say what it changed TO, and the API response carries no identifier
 * for the new model either. So the date is all we get, and the date is all we
 * claim. Nothing here should ever be extended into a guess about which model is
 * now behind an id.
 *
 * HOW TO ADD A NEW ONE
 * --------------------
 * Append one line to `MODEL_POINTER_EVENTS` below. Copy the shape of the line
 * above it: model id, `YYYY-MM-DD` date, kind, whether the source states the
 * change plainly (`confirmed`), the source URL, and a `note` quoting the source
 * verbatim so the next maintainer can re-check the reading without re-doing the
 * research. Order does not matter — the lookup sorts. Keep entries even after
 * an id is retired: historical reporting periods still span them.
 *
 * Then move `MODEL_POINTER_REGISTRY_CHECKED_THROUGH` to the day you read the
 * sources. Adding an event without moving that date leaves every disclosure
 * claiming knowledge older than it has; moving it without re-reading every
 * source is worse, because that date is what the product tells operators.
 *
 * THIS LIST ROTS IF NOBODY UPDATES IT. That is the standing risk of the whole
 * approach: a missing entry means a silent model change reported to a client as
 * their own performance. There is no feed to automate this against: deprecations
 * are published as a parseable page, but a re-point exists only as a sentence in
 * a rendered HTML changelog. So: re-read the changelog whenever a moving id shows
 * up in a project's configuration, and whenever a number moves without an
 * explanation. Nothing here fails closed on its own — the only protection
 * against a stale list is that every disclosure states when it was last checked.
 */

/**
 * What a source says happened to a model id on a date.
 *
 * - `introduced` — the id started existing. Provenance only.
 * - `repointed` — the SAME id started resolving to a different model. This is
 *   the invisible one, and the only kind that produces a disclosure.
 * - `retired`  — the id stopped being served. Loud by construction (calls fail
 *   or the operator re-configures), and the configured/served model evidence
 *   already shows it, so it does not produce a disclosure either.
 */
export const modelPointerEventKindSchema = z.enum(['introduced', 'repointed', 'retired'])
export type ModelPointerEventKind = z.infer<typeof modelPointerEventKindSchema>
export const ModelPointerEventKinds = modelPointerEventKindSchema.enum

export const modelPointerEventSchema = z.object({
  /** The moving model id as the provider spells it, e.g. `chat-latest`. */
  modelId: z.string().trim().min(1),
  /** Calendar day the source attributes the event to, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  kind: modelPointerEventKindSchema,
  /**
   * False when the source is ambiguous about whether the model actually
   * changed. An unverified change still discloses — under-warning is the
   * expensive direction — but the copy hedges instead of asserting.
   */
  confirmed: z.boolean(),
  /** Public page a maintainer can re-read to check this entry. */
  sourceUrl: z.string().url(),
  /** Verbatim quote or reading note, so the entry can be audited without re-research. */
  note: z.string().min(1),
})
export type ModelPointerEvent = z.infer<typeof modelPointerEventSchema>

/**
 * The seed record. Every entry below was checked against the linked official
 * page. Append new ones at the bottom.
 */
export const MODEL_POINTER_EVENTS: readonly ModelPointerEvent[] = [
  { modelId: 'chatgpt-4o-latest', date: '2024-08-15', kind: 'introduced', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim: "Released dynamic model for chatgpt-4o-latest—this model will point to the latest GPT-4o model used by ChatGPT." First moving id in the lineage.' },
  { modelId: 'chatgpt-4o-latest', date: '2026-02-17', kind: 'retired', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/deprecations.md', note: 'Shutdown 2026-02-17, replacement gpt-5.1-chat-latest. Announced under the heading "2025-11-18: chatgpt-4o-latest snapshot".' },
  { modelId: 'gpt-5.1-chat-latest', date: '2025-11-13', kind: 'introduced', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Introduced inside the GPT-5.1 launch entry, not as a standalone entry.' },
  { modelId: 'gpt-5.2-chat-latest', date: '2025-12-11', kind: 'introduced', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Introduced inside the GPT-5.2 launch entry.' },
  { modelId: 'gpt-5.2-chat-latest', date: '2026-02-10', kind: 'repointed', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim: "Updated the gpt-5.2-chat-latest slug to point to the latest model currently used in ChatGPT." Target model NOT named.' },
  { modelId: 'gpt-5.3-chat-latest', date: '2026-03-03', kind: 'introduced', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim: "Released gpt-5.3-chat-latest to the Chat Completions and Responses API. This model points to the GPT-5.3 Instant snapshot currently used in ChatGPT."' },
  { modelId: 'gpt-5.3-chat-latest', date: '2026-03-16', kind: 'repointed', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim: "Updated the gpt-5.3-chat-latest slug to point to the latest model currently used in ChatGPT." Target model NOT named.' },
  { modelId: 'chat-latest', date: '2026-05-05', kind: 'introduced', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim: "Released chat-latest snapshot which points to the latest Instant model currently used in ChatGPT... The underlying model snapshot will be regularly updated."' },
  { modelId: 'chat-latest', date: '2026-05-28', kind: 'repointed', confirmed: false, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'UNCONFIRMED. The entry reads "Released chat-latest snapshot..." — the verb is "Released", the same boilerplate as the 2026-05-05 entry, not "Updated" as used on 2026-06-24. Only "the latest improvements" vs "our latest improvements" differs. Either a real change logged with copy-pasted text, or a duplicated entry; the record does not disambiguate.' },
  { modelId: 'chat-latest', date: '2026-06-24', kind: 'repointed', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'Verbatim (re-read at source 2026-07-20): "Updated the chat-latest snapshot, which points to the latest Instant model currently used in ChatGPT." The verb is "Updated", unlike the "Released" boilerplate of 2026-05-05 and 2026-05-28, which is the wording the changelog reserves for a real change. Target model NOT named. The only unambiguous chat-latest change on record.' },
]

/**
 * Only a re-point produces a disclosure. An `introduced` date is the day the id
 * started existing, so no reporting period can straddle a change in what it
 * resolves to; a `retired` id fails loudly and already shows up as a configured
 * model change. The silent one — same id, different model, identical API
 * response — is `repointed`, and that is the whole reason this check exists.
 */
const DISCLOSING_KINDS: ReadonlySet<ModelPointerEventKind> = new Set([ModelPointerEventKinds.repointed])

/**
 * Every model id the registry knows to be a moving pointer. Derived from the
 * events so a registry entry is the single edit that also marks an id exposed.
 */
export const KNOWN_MOVING_POINTER_MODEL_IDS: ReadonlySet<string> = new Set(
  MODEL_POINTER_EVENTS.map(event => event.modelId.toLowerCase()),
)

/**
 * True when a model id names "whatever the provider is currently using" rather
 * than a fixed model — which is what decides whether a project is exposed to
 * this problem at all. A project on a pinned id never gets a disclosure.
 *
 * Two ways an id qualifies, and the second one matters most: a `-latest` suffix
 * is the universal vendor convention for a moving id (`chat-latest`,
 * `chatgpt-4o-latest`, `gpt-5.3-chat-latest`, and the Anthropic `-latest`
 * aliases), so a pointer shipped tomorrow is treated as exposed BEFORE anyone
 * gets around to adding it to the registry. The registry then supplies the
 * dates. Failing this open would mean silently treating a moving id as pinned.
 */
export function isMovingPointerModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (id.length === 0) return false
  return KNOWN_MOVING_POINTER_MODEL_IDS.has(id) || id.endsWith('-latest')
}

/**
 * The day a maintainer last read the provider changelogs end to end and
 * confirmed the list below is complete through that date.
 *
 * This is the honesty marker for the whole feature. There is no machine-readable
 * feed for these events — the deprecation page is parseable, but a re-point is
 * announced only as a sentence in a rendered HTML changelog — so the list is
 * maintained by hand and WILL fall behind. Knowing nothing happened is only
 * worth something alongside the date we last looked, so every disclosure carries
 * this date and a reporting period reaching past it is reported as unchecked
 * rather than as clear.
 *
 * Move this forward ONLY after re-reading every `sourceUrl` below.
 */
export const MODEL_POINTER_REGISTRY_CHECKED_THROUGH = '2026-07-20'

/**
 * How exposed a set of numbers is to a silent model change.
 *
 * - `not-exposed` — every model id the project ran is a fixed one. Nothing to
 *   say, and nothing should render.
 * - `no-known-change` — the project ran a moving id and we know of no change to
 *   it while it was running. NOT the same as safe: it is the answer a stale
 *   list also gives, which is why this state carries `knownGoodAsOf` and has to
 *   be sayable on a surface instead of collapsing into silence.
 * - `known-change` — a change we have a date for landed while the project was
 *   running the id. The number is contaminated and the caveat is mandatory.
 *
 * Collapsing the middle state into the first is the failure this feature
 * exists to prevent: a list that has rotted would read as "nothing happened".
 */
export const modelPointerExposureStatusSchema = z.enum(['not-exposed', 'no-known-change', 'known-change'])
export type ModelPointerExposureStatus = z.infer<typeof modelPointerExposureStatusSchema>
export const ModelPointerExposureStatuses = modelPointerExposureStatusSchema.enum

/**
 * One known change that landed inside the period, carried through to the
 * surfaces so they can word a confirmed and an unconfirmed event differently
 * without re-deriving anything from the registry.
 */
export const modelPointerChangeSchema = z.object({
  modelId: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** False when the source does not plainly state that the model changed. */
  confirmed: z.boolean(),
  sourceUrl: z.string().url(),
})
export type ModelPointerChange = z.infer<typeof modelPointerChangeSchema>

/**
 * The FACTS about a number produced on a moving model id — either that a known
 * change landed inside the period, or that the id can change under us and all
 * we can honestly report is how recently we checked.
 *
 * Deliberately carries no prose. The sentence a person reads is built from these
 * fields by `buildModelChangeNotice` below, on whichever surface is rendering,
 * so there is exactly one wording of this caveat in the product. An earlier cut
 * shipped a server-rendered `summary` alongside surfaces that each built their
 * own sentence; three wordings of one warning is the failure this lane exists to
 * prevent, so the wire carries data and the copy has a single home.
 */
export const modelPointerChangeDisclosureSchema = z.object({
  /** Which of the two exposed states this is. Never `not-exposed`: those are omitted entirely. */
  status: z.enum(['no-known-change', 'known-change']),
  /** Every moving model id the project actually ran in this period, sorted. */
  modelIds: z.array(z.string().trim().min(1)).min(1),
  /**
   * The known changes that landed while the project was running the id, oldest
   * first. Empty exactly when `status` is `no-known-change`.
   */
  changes: z.array(modelPointerChangeSchema),
  /** `changes.length`, kept as its own field so a surface can branch without walking the list. */
  changeCount: z.number().int().nonnegative(),
  /**
   * How many of `changeCount` come from a source that does not plainly state a
   * change happened. Those are never asserted as fact in the copy, and never
   * dropped either — one direction overstates risk, the other hides it.
   */
  unverifiedChangeCount: z.number().int().nonnegative(),
  /** Earliest change date inside the period, `YYYY-MM-DD`. Absent when there is none. */
  firstChangeDate: z.string().optional(),
  /** Latest change date inside the period. Equal to `firstChangeDate` when there is one change. */
  lastChangeDate: z.string().optional(),
  /** The day the change list was last checked against the provider's own pages. */
  knownGoodAsOf: z.string(),
  /**
   * False when the reporting period runs past `knownGoodAsOf` — the stretch
   * after that date has not been checked at all, so the absence of a change
   * there is ignorance, not evidence.
   */
  checkedThroughPeriodEnd: z.boolean(),
})
export type ModelPointerChangeDisclosure = z.infer<typeof modelPointerChangeDisclosureSchema>

/** A project that ran no moving model id at all. Nothing renders. */
export interface ModelPointerNotExposed {
  status: typeof ModelPointerExposureStatuses['not-exposed']
}

export type ModelPointerExposure = ModelPointerNotExposed | ModelPointerChangeDisclosure

/**
 * The span over which the project was actually running ONE model id, taken from
 * the sweeps themselves.
 *
 * This is the whole correctness of the feature. Crossing "ids seen anywhere in
 * the period" with "the period" warns a project that switched off a moving id in
 * March about a change in June, and stays silent for the mirror case. A change
 * only matters if the project was running that id when it happened.
 */
export interface ModelExposureWindow {
  modelId: string
  /** First sweep instant this id was observed on. `YYYY-MM-DD` or a full ISO timestamp. */
  firstSeen: string
  /** Last sweep instant this id was observed on. Same formats. */
  lastSeen: string
}

export interface ModelPointerExposureQuery {
  /**
   * One entry per model id the project ran — configured and served alike, since
   * either side being a moving id exposes the number. Fixed ids are ignored, so
   * passing everything is correct.
   */
  exposures: Iterable<ModelExposureWindow>
  /**
   * The reporting period these numbers cover. MUST be the same period the
   * metrics themselves were computed over — a caveat describing a different
   * window than the number it sits under is worse than no caveat.
   */
  periodStart: string
  /** End of that same period. Inclusive. */
  periodEnd: string
}

/**
 * Determine how exposed a set of numbers is to a silent model change.
 *
 * A change counts only when its date falls inside the period AND inside the span
 * over which the project was running that particular id. Both bounds are
 * INCLUSIVE and compared as UTC calendar days: a change dated on the first or
 * last day the id was seen counts, because a sweep on that day may have run on
 * either side of the swap.
 *
 * Never returns `undefined`. A project running a moving id with nothing known
 * against it gets the middle state, not silence — see
 * `modelPointerExposureStatusSchema`.
 */
export function evaluateModelPointerExposure(query: ModelPointerExposureQuery): ModelPointerExposure {
  const periodStart = formatIsoDate(query.periodStart)
  const periodEnd = formatIsoDate(query.periodEnd)
  if (periodStart > periodEnd) return { status: ModelPointerExposureStatuses['not-exposed'] }

  // Merge by lowercase id but keep the first spelling seen: the copy quotes the
  // id back at the operator, and it should look like what they configured.
  const exposed = new Map<string, { modelId: string; start: string; end: string }>()
  for (const exposure of query.exposures) {
    const modelId = exposure.modelId.trim()
    if (modelId.length === 0 || !isMovingPointerModelId(modelId)) continue
    const firstSeen = formatIsoDate(exposure.firstSeen)
    const lastSeen = formatIsoDate(exposure.lastSeen)
    if (firstSeen > lastSeen) continue
    const key = modelId.toLowerCase()
    const existing = exposed.get(key)
    if (!existing) {
      exposed.set(key, { modelId, start: firstSeen, end: lastSeen })
      continue
    }
    if (firstSeen < existing.start) existing.start = firstSeen
    if (lastSeen > existing.end) existing.end = lastSeen
  }
  if (exposed.size === 0) return { status: ModelPointerExposureStatuses['not-exposed'] }

  const repoints = MODEL_POINTER_EVENTS.filter(event => DISCLOSING_KINDS.has(event.kind))
  const matches: ModelPointerChange[] = []
  for (const event of repoints) {
    const window = exposed.get(event.modelId.trim().toLowerCase())
    if (!window) continue
    // Clamped to the reporting period as well as to the exposure window, so a
    // caller passing a wider window than the period cannot widen the caveat.
    const from = window.start > periodStart ? window.start : periodStart
    const to = window.end < periodEnd ? window.end : periodEnd
    if (from > to) continue
    if (event.date < from || event.date > to) continue
    matches.push({ modelId: event.modelId, date: event.date, confirmed: event.confirmed, sourceUrl: event.sourceUrl })
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.modelId.localeCompare(b.modelId))

  const knownGoodAsOf = MODEL_POINTER_REGISTRY_CHECKED_THROUGH
  const checkedThroughPeriodEnd = periodEnd <= knownGoodAsOf
  const ranIds = [...exposed.values()].map(w => w.modelId).sort()

  if (matches.length === 0) {
    // The fail-safe state, and the reason it is a state at all rather than an
    // absence: a list nobody has updated in six months produces exactly this,
    // and it must not be renderable as "you are fine". `knownGoodAsOf` travels
    // with it so whatever surface renders it has to say when we last looked.
    return {
      status: ModelPointerExposureStatuses['no-known-change'],
      modelIds: ranIds,
      changes: [],
      changeCount: 0,
      unverifiedChangeCount: 0,
      knownGoodAsOf,
      checkedThroughPeriodEnd,
    }
  }

  return {
    status: ModelPointerExposureStatuses['known-change'],
    modelIds: ranIds,
    changes: matches,
    changeCount: matches.length,
    // Unconfirmed events are counted separately rather than folded in — the
    // 2026-05-28 entry is the reason: its changelog wording does not
    // distinguish a real change from a duplicated announcement, and a client on
    // that window would otherwise be told a provider changed their model when
    // the record does not actually say so.
    unverifiedChangeCount: matches.filter(m => !m.confirmed).length,
    firstChangeDate: matches[0]!.date,
    lastChangeDate: matches[matches.length - 1]!.date,
    knownGoodAsOf,
    checkedThroughPeriodEnd,
  }
}

/**
 * Answer engines in the reader's vocabulary. The disclosure record is keyed by
 * our internal provider name, but the person about to send this number to a
 * client thinks in ChatGPT / Claude / Gemini / Perplexity. A caveat naming a
 * model id is one they cannot map onto anything they are looking at, so the
 * engine name is what every sentence below leads with — never the model id.
 */
const ANSWER_ENGINE_NAMES: Record<string, string> = {
  openai: 'ChatGPT',
  chatgpt: 'ChatGPT',
  anthropic: 'Claude',
  claude: 'Claude',
  google: 'Gemini',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
}

function answerEngineName(provider: string): string {
  const key = provider.trim().toLowerCase()
  return ANSWER_ENGINE_NAMES[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * What a surface should say about provider-side model updates, if anything.
 *
 * - `change` — a known update landed inside the period. This is the caveat, and
 *   it belongs where the reader meets it BEFORE the numbers.
 * - `no-known-change` — the project ran a model id that can be moved onto a
 *   different model, and nothing is on record inside the period. Rendered
 *   quietly, because this is the common case on every load, but rendered: this
 *   is also what a record nobody has updated produces, so `detail` always says
 *   when the record was last checked.
 *
 * `detail` is the supporting explanation. A surface with somewhere to put it
 * (a tooltip) should; a surface without one (the CLI) prints it as a second
 * line. It is never dropped — it carries the freshness of the record.
 */
export type ModelChangeNotice =
  | { kind: 'change'; text: string }
  | { kind: 'no-known-change'; text: string; detail: string }

/**
 * One engine's exposure, normalized out of whatever the server sent. Every
 * field is derived defensively: this is a decoded HTTP response from a server
 * that may be older or newer than the code reading it.
 */
interface EngineModelChange {
  engine: string
  confirmedDates: string[]
  unconfirmedDates: string[]
  confirmedCount: number
  unconfirmedCount: number
  knownGoodAsOf: string | null
  checkedThroughPeriodEnd: boolean
}

/**
 * The wire shape, widened. Everything is optional because none of it is
 * guaranteed by the server on the other end of the connection.
 */
type WireModelPointerChange = Partial<ModelPointerChangeDisclosure> & {
  changes?: readonly { date?: string | null; confirmed?: boolean | null }[] | null
  unconfirmedChangeCount?: number | null
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Day stamps only. A full ISO instant would print a time nobody can act on. */
function dayOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length >= 10 ? value.trim().slice(0, 10) : null
}

function sortedUnique(days: (string | null)[]): string[] {
  return [...new Set(days.filter((d): d is string => d !== null))].sort()
}

function normalizeEngineChange(provider: string, entry: WireModelPointerChange): EngineModelChange {
  const engine = answerEngineName(provider)
  const perChange = Array.isArray(entry.changes) ? entry.changes : []
  const changeCount = countOf(entry.changeCount) || perChange.length
  // `unverifiedChangeCount` is the field the current server sends;
  // `unconfirmedChangeCount` is accepted so a rename cannot silently turn every
  // hedged update into an asserted one, and the per-update array is the last
  // fallback so a server that only ships the breakdown still hedges correctly.
  const unconfirmedCount = Math.min(
    changeCount,
    countOf(entry.unverifiedChangeCount)
      || countOf(entry.unconfirmedChangeCount)
      || perChange.filter(c => c.confirmed === false).length,
  )
  // No fallback to this build's own constant. Claiming a freshness the server
  // did not state would be the exact lie the field exists to prevent, so an
  // older server that omits it simply gets no freshness sentence.
  const knownGoodAsOf = dayOf(entry.knownGoodAsOf)
  const checkedThroughPeriodEnd = entry.checkedThroughPeriodEnd !== false
  const common = {
    engine,
    confirmedCount: changeCount - unconfirmedCount,
    unconfirmedCount,
    knownGoodAsOf,
    checkedThroughPeriodEnd,
  }

  if (perChange.length > 0) {
    return {
      ...common,
      confirmedDates: sortedUnique(perChange.filter(c => c.confirmed !== false).map(c => dayOf(c.date))),
      unconfirmedDates: sortedUnique(perChange.filter(c => c.confirmed === false).map(c => dayOf(c.date))),
    }
  }

  // No per-update breakdown. The outer dates can only be attributed when every
  // update in the period has the same confidence; a mixed period gets no dates
  // rather than a date attached to the wrong claim.
  const span = sortedUnique([dayOf(entry.firstChangeDate), dayOf(entry.lastChangeDate)])
  if (changeCount === 0) return { ...common, confirmedDates: [], unconfirmedDates: [] }
  if (unconfirmedCount === 0) return { ...common, confirmedDates: span, unconfirmedDates: [] }
  if (common.confirmedCount === 0) return { ...common, confirmedDates: [], unconfirmedDates: span }
  return { ...common, confirmedDates: [], unconfirmedDates: [] }
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/** "on 2026-06-24" for a single dated update, a range for several. */
function whenPhrase(dates: readonly string[], count: number): string | null {
  if (dates.length === 0) return null
  if (dates.length === 1 && count <= 1) return `on ${dates[0]}`
  return `more than once between ${dates[0]} and ${dates[dates.length - 1]}`
}

/**
 * The per-engine clause. It says WHAT happened and to WHICH engine, and nothing
 * else — the consequence and the instruction are one shared sentence at the end,
 * so two affected engines produce two facts and not two warnings.
 */
function engineClause(change: EngineModelChange): string {
  const confirmedWhen = whenPhrase(change.confirmedDates, change.confirmedCount)
  const unconfirmedWhen = whenPhrase(change.unconfirmedDates, change.unconfirmedCount)
  const subject = `The model behind ${change.engine}`

  if (change.confirmedCount > 0 && change.unconfirmedCount === 0) {
    return confirmedWhen
      ? `${subject} was updated ${confirmedWhen}, inside this period.`
      : `${subject} was updated inside this period.`
  }
  if (change.confirmedCount === 0) {
    // Never stated as fact. The record hints at an update and does not settle it.
    return unconfirmedWhen
      ? `${subject} may have been updated ${unconfirmedWhen}, inside this period, though that is not confirmed.`
      : `${subject} may have been updated inside this period, though that is not confirmed.`
  }
  if (confirmedWhen && unconfirmedWhen) {
    return `${subject} was updated ${confirmedWhen}, inside this period, and may also have been updated ${unconfirmedWhen}.`
  }
  const more = change.unconfirmedCount > 1 ? 'more times' : 'once more'
  return `${subject} was updated inside this period, and may have been updated ${more}, though that is not confirmed.`
}

/**
 * The date we last read the provider changelogs, as a sentence, when the period
 * runs past it. Silence about the unchecked tail would let ignorance read as
 * evidence, which is the whole point of carrying the date on the wire.
 *
 * Returns null when the period is fully covered (nothing to warn about) or when
 * the server never told us the date (nothing we can honestly say).
 */
function uncheckedTailSentence(entries: readonly EngineModelChange[]): string | null {
  const unchecked = entries.filter(e => !e.checkedThroughPeriodEnd && e.knownGoodAsOf !== null)
  if (unchecked.length === 0) return null
  // The oldest check is the honest one to quote: it bounds what we know across
  // every engine on the surface.
  const oldest = unchecked.map(e => e.knownGoodAsOf!).sort()[0]!
  return `We last checked for model updates on ${oldest}, and this period runs past that date,`
    + ' so there may be later updates we do not know about.'
}

/**
 * Build the whole notice from the per-provider record a metrics response
 * carried.
 *
 * Lives here rather than in each surface because the dashboard, the CLI, and
 * anything else reading this DTO must not word the same warning differently — a
 * softer sentence on one surface is the failure this whole lane exists to
 * prevent. Each engine contributes one fact and the notice closes with one
 * consequence, once, however many engines are affected.
 *
 * Returns `null` when there is nothing to say at all: an older server omits the
 * field entirely, and a project on fixed model ids has an empty record.
 */
export function buildModelChangeNotice(
  disclosures: Record<string, WireModelPointerChange | null | undefined> | undefined,
): ModelChangeNotice | null {
  const entries = Object.entries(disclosures ?? {})
    .map(([provider, entry]) => normalizeEngineChange(provider, entry ?? {}))
    .sort((a, b) => a.engine.localeCompare(b.engine))
  if (entries.length === 0) return null

  const changed = entries.filter(e => e.confirmedCount + e.unconfirmedCount > 0)
  if (changed.length === 0) {
    // Exposed, nothing on record. One quiet line, with the reason it matters and
    // the age of the record in the detail rather than on the surface — this
    // renders on every load for anyone on a moving model id and must not become
    // noise. But it is never silence: silence is what a rotted record looks
    // like, and it would read as proof that nothing happened.
    const engines = [...new Set(entries.map(e => e.engine))]
    const plural = engines.length > 1
    // The unchecked-tail sentence already names the date and is the stronger
    // statement, so it replaces the plain "we last checked" rather than joining
    // it — saying both would name the same date twice in two sentences.
    const tail = uncheckedTailSentence(entries)
    const checked = [...new Set(entries.map(e => e.knownGoodAsOf).filter((d): d is string => d !== null))].sort()
    const freshness = tail ?? (checked.length > 0 ? `We last checked for model updates on ${checked[0]}.` : null)
    return {
      kind: 'no-known-change',
      text: `No model updates are on record for ${joinNames(engines)} in this period.`,
      detail: `${plural ? 'These engines' : 'This engine'} can be moved onto a different underlying model`
        + ' without the data ever showing a different model name, so we check each period against a record of'
        + ` known updates. Nothing is listed inside this one.${freshness ? ` ${freshness}` : ''}`,
    }
  }

  const totalChanges = changed.reduce((n, e) => n + e.confirmedCount + e.unconfirmedCount, 0)
  const anyConfirmed = changed.some(e => e.confirmedCount > 0)
  const noun = totalChanges === 1 ? 'this update' : 'these updates'
  // One consequence, one instruction, however many engines are affected. The
  // subject is "these numbers" because a surface plots several of them.
  const consequence = anyConfirmed
    ? `Some of the movement in these numbers may come from ${noun} rather than from a real change in how AI answers about you, so compare periods carefully.`
    : `If so, some of the movement in these numbers may come from ${noun} rather than from a real change in how AI answers about you, so compare periods carefully.`
  // The known updates are the headline, but an unchecked tail still has to be
  // said out loud: "we found one" must not imply "we found all of them".
  const tail = uncheckedTailSentence(entries)

  return { kind: 'change', text: `${changed.map(engineClause).join(' ')} ${consequence}${tail ? ` ${tail}` : ''}` }
}
