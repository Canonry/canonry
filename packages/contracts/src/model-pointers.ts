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
 * THIS LIST ROTS IF NOBODY UPDATES IT. That is the standing risk of the whole
 * approach: a missing entry means a silent model change reported to a client as
 * their own performance. Re-read the changelog whenever a pointer id shows up in
 * a project's configuration, and whenever a number moves without an explanation.
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
  { modelId: 'chat-latest', date: '2026-06-24', kind: 'repointed', confirmed: true, sourceUrl: 'https://developers.openai.com/api/docs/changelog', note: 'The changelog entry uses the verb "Updated" (unlike the "Released" boilerplate of 2026-05-05 and 2026-05-28), which is the wording reserved for a real change. Target model NOT named. Re-read the source before relying on the exact wording — this entry was recorded from the 2026-05-28 comparison, not quoted directly.' },
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
 * A plain-language caveat for a number whose reporting period spans one or more
 * known changes to a model the project actually ran.
 */
export const modelPointerChangeDisclosureSchema = z.object({
  /** The moving model ids the project ran that changed inside the period, sorted. */
  modelIds: z.array(z.string().trim().min(1)).min(1),
  /** How many known changes landed inside the period, across those ids. */
  changeCount: z.number().int().positive(),
  /**
   * How many of `changeCount` come from a source that does not plainly state a
   * change happened. Equal to `changeCount` means the whole caveat is hedged.
   */
  unverifiedChangeCount: z.number().int().nonnegative(),
  /** Earliest change date inside the period, `YYYY-MM-DD`. */
  firstChangeDate: z.string(),
  /** Latest change date inside the period. Equal to `firstChangeDate` when there is one change. */
  lastChangeDate: z.string(),
  /** Ready-to-render sentence. Says what happened and what it means for the number. */
  summary: z.string().min(1),
})
export type ModelPointerChangeDisclosure = z.infer<typeof modelPointerChangeDisclosureSchema>

export interface ModelPointerChangeQuery {
  /**
   * Every model id the project actually RAN over the period — configured and
   * served alike. Pinned ids are ignored, so passing the full set is correct
   * and a project on a pinned id gets nothing back.
   */
  modelIds: Iterable<string>
  /** Start of the reporting period. `YYYY-MM-DD` or a full ISO timestamp. Inclusive. */
  start: string
  /** End of the reporting period. Same formats. Inclusive. */
  end: string
}

function quoted(modelIds: readonly string[]): string {
  const quotedIds = modelIds.map(id => `"${id}"`)
  if (quotedIds.length === 1) return quotedIds[0]!
  if (quotedIds.length === 2) return `${quotedIds[0]} and ${quotedIds[1]}`
  return `${quotedIds.slice(0, -1).join(', ')}, and ${quotedIds[quotedIds.length - 1]}`
}

/**
 * Determine whether any moving model id the project actually ran was changed
 * inside the reporting period.
 *
 * Boundaries are INCLUSIVE on both ends and compared as calendar days: a change
 * dated exactly on the first or last day of the period counts, because a sweep
 * on that day may have run on either side of it. Returns `undefined` when the
 * project ran no moving id, or ran one with no known change in range — those
 * are the same answer to a reader ("nothing to caveat") and neither should
 * produce a warning.
 */
export function findModelPointerChanges(query: ModelPointerChangeQuery): ModelPointerChangeDisclosure | undefined {
  const exposedIds = new Set<string>()
  for (const modelId of query.modelIds) {
    const id = modelId.trim()
    if (id.length > 0 && isMovingPointerModelId(id)) exposedIds.add(id.toLowerCase())
  }
  if (exposedIds.size === 0) return undefined

  // Compared as UTC calendar days, so a full sweep instant and a bare day stamp
  // are the same kind of value by the time they reach the range check.
  const startDay = formatIsoDate(query.start)
  const endDay = formatIsoDate(query.end)
  if (startDay > endDay) return undefined

  const matches = MODEL_POINTER_EVENTS
    .filter(event => DISCLOSING_KINDS.has(event.kind))
    .filter(event => exposedIds.has(event.modelId.trim().toLowerCase()))
    .filter(event => event.date >= startDay && event.date <= endDay)
    .sort((a, b) => a.date.localeCompare(b.date) || a.modelId.localeCompare(b.modelId))

  if (matches.length === 0) return undefined

  const modelIds = [...new Set(matches.map(event => event.modelId))].sort()
  const changeCount = matches.length
  const unverifiedChangeCount = matches.filter(event => !event.confirmed).length
  const firstChangeDate = matches[0]!.date
  const lastChangeDate = matches[matches.length - 1]!.date
  const allUnverified = unverifiedChangeCount === changeCount

  const subject = `The model behind ${quoted(modelIds)}`
  const verb = allUnverified ? 'may have changed' : 'changed'
  // Several changes are reported as "more than once" with the outer dates —
  // a reader needs to know the number is unreliable, not a change log.
  const what = changeCount > 1
    ? `${subject} ${verb} more than once in this reporting period, between ${firstChangeDate} and ${lastChangeDate}.`
    : `${subject} ${verb} on ${firstChangeDate}, inside this reporting period.`

  const those = changeCount > 1 ? 'those changes' : 'that change'
  const hedge = allUnverified ? (changeCount > 1 ? 'If they did, part' : 'If it did, part') : 'Part'
  const soFar = `${hedge} of any movement in this number comes from ${those} and not from how often AI names you.`

  return {
    modelIds,
    changeCount,
    unverifiedChangeCount,
    firstChangeDate,
    lastChangeDate,
    summary: `${what} ${soFar}`,
  }
}

/**
 * What the reader is supposed to DO about it, and the reason the caveat is on
 * screen at all: somebody is about to put this number in front of a client.
 * Appended once, however many engines are affected — repeating it would read as
 * two separate warnings about the same number.
 */
export const MODEL_CHANGE_NEXT_ACTION = 'Compare this period with earlier ones carefully.'

/**
 * The whole caveat as one short paragraph, given the per-provider disclosures a
 * metrics response carried.
 *
 * Lives here rather than in each surface because the dashboard, the CLI, and
 * anything else reading this DTO must not word the same warning three different
 * ways — a softer sentence on one surface is the failure this whole lane exists
 * to prevent. The per-provider sentences are rendered verbatim and ordered by
 * provider so the paragraph is stable between reads.
 *
 * Returns `null` when there is nothing to say: an older server omits the field,
 * a project on fixed model ids has an empty record, and an entry with no usable
 * sentence is dropped rather than rendered half-stated.
 */
export function formatModelChangeDisclosure(
  // Deliberately `Partial`: the caller is reading a decoded HTTP response, not a
  // value this process built, so `summary` is a claim about the wire and an
  // entry that fails it is dropped rather than rendered half-stated.
  disclosures: Record<string, Partial<ModelPointerChangeDisclosure>> | undefined,
): string | null {
  const summaries = Object.entries(disclosures ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.summary?.trim())
    .filter((summary): summary is string => summary !== undefined && summary.length > 0)
  if (summaries.length === 0) return null
  return `${summaries.join(' ')} ${MODEL_CHANGE_NEXT_ACTION}`
}
