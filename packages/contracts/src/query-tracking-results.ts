import { z } from 'zod'
import { queryTrackingModeSchema } from './query-tracking.js'
import { fraction } from './ratio-unit.js'
import { RunStatuses } from './run.js'
import {
  visibilityReportPopulationClassSchema,
  visibilityReportRateSchema,
  visibilityReportScopeKindSchema,
} from './visibility-report.js'

/**
 * Engine results for every tracked query in one read: was a covered location
 * mentioned in the answer text, and was one cited in the answer's sources.
 * The two are separate signals and neither is ever computed from the other.
 * Branded and non-brand results of one query are separate rows, never pooled.
 */

const nonBlankIdSchema = z.string().trim().min(1)
const countSchema = z.number().int().nonnegative()
/** An optional count is omitted at zero, so a row with nothing to report keeps its bytes. */
const positiveCountSchema = z.number().int().positive()
/** Location keys, sorted. Omitted when empty. */
const targetKeysSchema = z.array(nonBlankIdSchema).min(1)

/** The signal a list is read by: answer text (mentioned) or sources (cited). The two are never computed from each other. */
export const queryTrackingSignalSchema = z.enum(['mentioned', 'cited'])
export type QueryTrackingSignal = z.output<typeof queryTrackingSignalSchema>
/** A sweep-to-sweep change of one engine's signal on the same query: gained or lost. */
export const queryTrackingChangeSchema = z.enum(['won', 'lost'])
export type QueryTrackingChange = z.output<typeof queryTrackingChangeSchema>
export const queryTrackingResultFilterSchema = z.enum(['mentioned', 'not-mentioned', 'cited', 'not-cited'])

const queryTrackingResultsRequestShape = {
  /** The place whose pairings are read. Resolved against the active plan. */
  scope: visibilityReportScopeKindSchema.default('project'),
  scopeKey: nonBlankIdSchema.optional(),
  /** One completed or partial whole-project sweep. Omit for the default sweep. */
  runId: nonBlankIdSchema.optional(),
  /**
   * One tracked query. The read then returns only that query's rows, each
   * engine entry with `answerRows`, and neither `totals` nor `weakMarkets`.
   */
  queryId: nonBlankIdSchema.optional(),
  /** The signal `sort`, `groups` and the "who won" lists read. Default `mentioned`. */
  signal: queryTrackingSignalSchema.optional(),
  /** Orders `rows` (and `groups`) by the signal's share of answers: lowest first, or highest first. Omit for query-id order. */
  sort: z.enum(['losing', 'winning']).optional(),
  /**
   * An advanced portfolio's roll-ups in `groups`: one per market, or one per
   * group of markets. Read at project or group scope, with no row filter. A
   * grouped read returns no `rows`: a market's queries are a read of that market.
   */
  group: z.enum(['market', 'group']).optional(),
  /** `previous`: compare with the sweep before the one read, on the same queries; rows gain each engine's change. */
  compare: z.literal('previous').optional(),
  /** Keep only rows whose `result` (and `change`) hold on this engine; without it, on any engine. */
  engine: nonBlankIdSchema.optional(),
  /** Keep only rows with this result on `engine`, or on any engine. Not checked is never a no. */
  result: queryTrackingResultFilterSchema.optional(),
  /** Keep only rows that won or lost the signal since the previous sweep. Needs `compare=previous`. */
  change: queryTrackingChangeSchema.optional(),
}

/** Plain serializable wire schema used by MCP and generated clients. */
export const queryTrackingResultsRequestSchema = z.object(queryTrackingResultsRequestShape).strict().superRefine((value, ctx) => {
  if (value.scope !== 'project' && value.scopeKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: `scopeKey is required for ${value.scope} scope` })
  }
  if (value.scope === 'project' && value.scopeKey !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: 'scopeKey is not valid for project scope' })
  }
  if (value.group !== undefined && (value.scope === 'market' || value.scope === 'property')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['group'], message: 'group is read at project or group scope' })
  }
  if (value.group !== undefined && value.queryId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['group'], message: 'group is not read with queryId' })
  }
  if (value.group !== undefined && (value.engine !== undefined || value.result !== undefined || value.change !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['group'], message: 'group is not read with engine, result or change' })
  }
  if (value.change !== undefined && value.compare === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['change'], message: 'change needs compare=previous' })
  }
})
export type QueryTrackingResultsRequest = z.input<typeof queryTrackingResultsRequestSchema>
export type QueryTrackingResultsQuery = z.output<typeof queryTrackingResultsRequestSchema>

/** One source an answer cited, with whose site it is. */
export const queryTrackingCitedSourceSchema = z.object({
  url: z.string().trim().min(1),
  /** The source's host, `www.` dropped. */
  host: z.string().trim().min(1),
  /** The host is one of the project's own sites. */
  ours: z.boolean(),
  /** The tracked competitor whose domain the source is, or null. */
  competitor: z.string().trim().min(1).nullable(),
}).strict()
export type QueryTrackingCitedSource = z.output<typeof queryTrackingCitedSourceSchema>

/**
 * One expected answer of one engine, returned only by a read of one query
 * (`queryId`). `mentioned` and `cited` are that answer under the rule the
 * engine counts use, so the answers add up to the counts beside them.
 */
export const queryTrackingAnswerRowSchema = z.object({
  /** The saved answer, for the answer read. Null when no answer text was saved. */
  resultId: nonBlankIdSchema.nullable(),
  /** The search location the answer was asked at; null when it was asked at none. */
  searchLocation: z.string().nullable(),
  /** The locations the row covers in the place through this answer, sorted. */
  targetKeys: z.array(nonBlankIdSchema),
  /** Null is not checked, never no. */
  mentioned: z.boolean().nullable(),
  /** Null is not checked: no answer, or sources only partly saved. */
  cited: z.boolean().nullable(),
  /** The locations in `targetKeys` the answer text names, sorted. */
  mentionedTargetKeys: z.array(nonBlankIdSchema),
  /** The locations in `targetKeys` the fully saved sources cite, sorted. */
  citedTargetKeys: z.array(nonBlankIdSchema),
  /**
   * Names the answer wrote in place of the row's locations: set only when the
   * answer did not mention the row. Cleaned (addresses trimmed, headings and
   * place names dropped, one spelling per name), in stored order.
   */
  namedInstead: z.array(z.string().trim().min(1)),
  /** The same names when the answer mentioned the row or could not be checked. Absent from a server that predates it. */
  alsoNamed: z.array(z.string().trim().min(1)).optional(),
  /** The sources the answer cited, in stored order. Absent from a server that predates it. */
  citedSources: z.array(queryTrackingCitedSourceSchema).optional(),
}).strict()
export type QueryTrackingAnswerRow = z.output<typeof queryTrackingAnswerRowSchema>

/**
 * One engine's result for one query and class in the place. A count never
 * stands in for the other signal: `mentionedAnswers` reads answer text,
 * `citedAnswers` reads sources. Every field after `cited` is optional and
 * omitted when it has nothing to report; none of them changes `mentioned`,
 * `cited` or a count.
 */
export const queryTrackingEngineResultSchema = z.object({
  provider: nonBlankIdSchema,
  /** Answers the sweep asked this engine for: one per search location the row is asked at. */
  expectedAnswers: countSchema,
  /** Answers saved, the base of both counts. */
  answers: countSchema,
  /** Saved answers whose text names a location the row covers in the place. */
  mentionedAnswers: countSchema,
  /** Saved answers with fully saved sources that cite a location the row covers in the place. */
  citedAnswers: countSchema,
  /** Saved answers whose sources were only partly saved. They are in neither side of the cited count. */
  uncheckedSourceAnswers: countSchema,
  /** True when any answer mentions it, false when every expected answer was checked and none did, else null (not checked). */
  mentioned: z.boolean().nullable(),
  /** The same rule over sources. Null is not checked, never no. */
  cited: z.boolean().nullable(),
  /** Saved answers left unchecked for the mention because a name in the text could not be tied to one location. */
  unattributedMentionAnswers: positiveCountSchema.optional(),
  /** On a row that covers more than one location in the place: the covered locations a saved answer names. */
  mentionedTargetKeys: targetKeysSchema.optional(),
  /** On such a row: the covered locations a saved answer with fully saved sources cites. */
  citedTargetKeys: targetKeysSchema.optional(),
  /**
   * Saved answers whose text names no location the row covers in the place and
   * does name another location of the plan. They are among the answers that
   * do not mention the row. In a place, a location outside it is another one.
   */
  otherLocationMentionedAnswers: positiveCountSchema.optional(),
  /** Those other locations. Present exactly when the count is. */
  otherLocationMentionedTargetKeys: targetKeysSchema.optional(),
  /** The same over fully saved sources that cite no location the row covers in the place. */
  otherLocationCitedAnswers: positiveCountSchema.optional(),
  /** Those other locations. Present exactly when the count is. */
  otherLocationCitedTargetKeys: targetKeysSchema.optional(),
  /** Only on a read of one query (`queryId`): one entry per expected answer. */
  answerRows: z.array(queryTrackingAnswerRowSchema).optional(),
  /** With `compare=previous`: the mention gained or lost on this engine since that sweep. Absent when unchanged or not comparable. */
  mentionChange: queryTrackingChangeSchema.optional(),
  /** The same for the citation. */
  citationChange: queryTrackingChangeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  // Saved answers that do not mention the row: each is a checked no or was left unchecked, never both.
  const notMentioned = value.answers - value.mentionedAnswers
  const unattributed = value.unattributedMentionAnswers ?? 0
  if (unattributed > notMentioned) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unattributedMentionAnswers'], message: 'unattributedMentionAnswers cannot exceed the answers that do not mention the row' })
  }
  const pairs = [
    ['otherLocationMentionedAnswers', 'otherLocationMentionedTargetKeys', Math.max(0, notMentioned - unattributed)],
    // Only an answer with fully saved sources that does not cite the row can cite another location.
    ['otherLocationCitedAnswers', 'otherLocationCitedTargetKeys', value.answers - value.citedAnswers - value.uncheckedSourceAnswers],
  ] as const
  for (const [count, keys, limit] of pairs) {
    if ((value[count] === undefined) !== (value[keys] === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [keys], message: `${count} and ${keys} are sent together` })
    }
    if ((value[count] ?? 0) > limit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [count], message: `${count} cannot exceed the answers checked that do not show the signal` })
    }
  }
  if (value.answerRows !== undefined && value.answerRows.length !== value.expectedAnswers) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answerRows'], message: 'answerRows holds one entry per expected answer' })
  }
})
export type QueryTrackingEngineResult = z.output<typeof queryTrackingEngineResultSchema>

export const queryTrackingResultRowSchema = z.object({
  queryId: nonBlankIdSchema,
  /** The text the sweep asked, which is the text tracked now. */
  queryText: z.string().trim().min(1),
  /** A class the workspace row carries in `queryClasses`, or `unknown` when it carries none. */
  queryClass: visibilityReportPopulationClassSchema,
  /** One entry per engine the sweep asked for this row, sorted by provider. */
  engines: z.array(queryTrackingEngineResultSchema),
}).strict()
export type QueryTrackingResultRow = z.output<typeof queryTrackingResultRowSchema>

export const queryTrackingResultsRunSchema = z.object({
  id: nonBlankIdSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum([RunStatuses.completed, RunStatuses.partial]),
  /** The plan revision the sweep ran with; null for a simple project. */
  revision: z.number().int().positive().nullable(),
  /**
   * False when tracking changed after this sweep, so some pairings may have no
   * row until the next one. A label-only republish keeps it true. On a simple
   * project, tracking is the tracked queries and the project's names, sites,
   * engines, models, search location, country and language; an older sweep
   * that recorded none of them is never a match.
   */
  matchesCurrentTracking: z.boolean(),
}).strict()
export type QueryTrackingResultsRun = z.output<typeof queryTrackingResultsRunSchema>

/** The rule's fixed name. The sweep it read is the one `run` names, also when `runId` picked an older one. */
export const QUERY_TRACKING_WEAK_MARKET_RULE = 'no-mention-latest-sweep'
/** The one class the weak-market rule reads. */
export const QUERY_TRACKING_WEAK_MARKET_CLASS = 'non-brand'

/**
 * One type's result over the returned rows, in answers. The two rates are the
 * report's own, so they carry its left-out counts (`unattributed`,
 * `unchecked`) and its reason when a rate is withheld.
 */
export const queryTrackingResultTotalsSchema = z.object({
  queryClass: visibilityReportPopulationClassSchema,
  /** Returned rows of this type: one per query. */
  queries: countSchema,
  /** Answers saved for those rows. */
  answers: countSchema,
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
  /**
   * With `compare=previous` and a previous sweep: both sweeps' rates over the
   * rows of this type that both measured, so a change is the same queries in
   * both. Absent with nothing to compare.
   */
  comparison: z.object({
    /** Rows of this type both sweeps measured. */
    queries: countSchema,
    mentionCoverage: visibilityReportRateSchema,
    citationCoverage: visibilityReportRateSchema,
    previousMentionCoverage: visibilityReportRateSchema,
    previousCitationCoverage: visibilityReportRateSchema,
    /** The server's own `mentionCoverage.rate - previousMentionCoverage.rate`; null when either is. */
    mentionDelta: fraction(z.number().min(-1).max(1)).nullable(),
    /** The same for the citation rates. */
    citationDelta: fraction(z.number().min(-1).max(1)).nullable(),
  }).strict().optional(),
}).strict()
export type QueryTrackingResultTotals = z.output<typeof queryTrackingResultTotalsSchema>

/** One listed weak market, counted over its own non-brand rows only. */
export const queryTrackingWeakMarketSchema = z.object({
  marketKey: nonBlankIdSchema,
  /** The market's own non-brand rows read. */
  queries: countSchema,
  /** Answers whose text was read. */
  mentionCheckedAnswers: countSchema,
  /** Of those, the answers naming a member location: 0 under this rule. */
  mentionedAnswers: countSchema,
  /** Of those, the answers naming no location the row covers and another location of the plan. */
  otherLocationMentionedAnswers: countSchema,
  /** Saved answers with fully saved sources. */
  citationCheckedAnswers: countSchema,
  /** Of those, the answers citing a member location. A citation never takes a market off the list. */
  citedAnswers: countSchema,
}).strict()
export type QueryTrackingWeakMarket = z.output<typeof queryTrackingWeakMarketSchema>

/**
 * Markets the sweep in `run` found weak, by one rule over the returned rows:
 * of the non-brand rows whose query has the market as its Subject, at least
 * one answer had its text read and none named a member location. A market
 * with no such answer read is left out, never listed, and so is one with such
 * a query withheld since a tracking change. Branded rows never count, so a
 * market named only for its branded queries is still weak.
 */
export const queryTrackingWeakMarketsSchema = z.object({
  rule: z.literal(QUERY_TRACKING_WEAK_MARKET_RULE),
  queryClass: z.literal(QUERY_TRACKING_WEAK_MARKET_CLASS),
  /** The length of `marketKeys`. */
  count: countSchema,
  /** In key order, not ranked: every listed market has no mention. */
  marketKeys: z.array(nonBlankIdSchema),
  /**
   * The same markets with their counts, weakest first: fewest cited answers,
   * then fewest answers naming another location, then most answers read, then
   * key. Absent from a server that predates it.
   */
  markets: z.array(queryTrackingWeakMarketSchema).optional(),
}).strict()
export type QueryTrackingWeakMarkets = z.output<typeof queryTrackingWeakMarketsSchema>

const positiveNamedCountSchema = z.number().int().positive()

/** One type's result in a group: the rates are the report's own, over the group's rows of that type. */
export const queryTrackingGroupTypeSchema = z.object({
  queryClass: visibilityReportPopulationClassSchema,
  queries: countSchema,
  answers: countSchema,
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
  /** Answers that named another location of the plan instead of the group's own. */
  otherLocationMentionedAnswers: countSchema,
  /** Per engine, in the response's engine order. */
  engines: z.array(z.object({
    provider: nonBlankIdSchema,
    answers: countSchema,
    mentionedAnswers: countSchema,
    citedAnswers: countSchema,
  }).strict()),
  /** With `compare=previous`: query and engine pairs that gained or lost each signal since that sweep. */
  change: z.object({
    mentionsWon: countSchema,
    mentionsLost: countSchema,
    citationsWon: countSchema,
    citationsLost: countSchema,
  }).strict().optional(),
}).strict()

/**
 * One market (or one group of markets) on a grouped read. A market's queries
 * are the queries whose Subject is that market, plus its locations' own
 * queries; a group holds its markets. Each answer counts once. The "who won"
 * lists read the group's non-brand answers that missed the signal.
 */
export const queryTrackingResultGroupSchema = z.object({
  kind: z.enum(['market', 'group']),
  key: nonBlankIdSchema,
  label: z.string().trim().min(1),
  /** The group a market sits in, or the group above a group. Null at the top. */
  parentKey: nonBlankIdSchema.nullable(),
  /** Locations in the market or group. */
  locations: countSchema,
  /** On a group: the markets in it, in key order. */
  marketKeys: z.array(nonBlankIdSchema).optional(),
  /** One entry per type that has a row, never pooled. */
  types: z.array(queryTrackingGroupTypeSchema),
  /** Names the non-brand answers gave when they did not mention the group, most answers first. */
  namedInstead: z.array(z.object({ name: z.string().trim().min(1), answers: positiveNamedCountSchema }).strict()),
  /** Sites the non-brand answers cited when they did not cite the group, ours left out, most answers first. */
  citedInstead: z.array(z.object({ host: z.string().trim().min(1), answers: positiveNamedCountSchema }).strict()),
  /** Tracked competitors the non-brand answers named or cited. */
  competitors: z.array(z.object({ domain: z.string().trim().min(1), mentionedAnswers: countSchema, citedAnswers: countSchema }).strict()),
}).strict()
export type QueryTrackingResultGroup = z.output<typeof queryTrackingResultGroupSchema>

export const queryTrackingResultsResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  /** The place read. `key` is null for the whole project. */
  scope: z.object({
    kind: visibilityReportScopeKindSchema,
    key: nonBlankIdSchema.nullable(),
  }).strict(),
  /** The sweep read; null when no whole-project sweep has finished. */
  run: queryTrackingResultsRunSchema.nullable(),
  /** Every engine that sweep asked, sorted. Empty with no sweep. */
  engines: z.array(nonBlankIdSchema),
  /**
   * One row per query and class whose every pairing in the place was asked by
   * the sweep exactly as it is asked now. A query moved, re-typed or reworded
   * since has no row until the next sweep, and neither has one whose engines,
   * models or search location changed (on a simple project also the country
   * or language).
   */
  rows: z.array(queryTrackingResultRowSchema),
  /** Query and class pairs asked in the place now that the sweep did not measure. */
  pendingRows: countSchema,
  /**
   * One entry per type that has a row, sorted by type and never pooled. They
   * cover the returned rows only, so a query counted in `pendingRows` is in no
   * total. Absent with no sweep, on a read of one query, and from a server
   * that predates it.
   */
  totals: z.array(queryTrackingResultTotalsSchema).optional(),
  /**
   * An advanced portfolio read at project scope with a sweep. Absent for any
   * other place, a simple project, no sweep, a read of one query, and a server
   * that predates it.
   */
  weakMarkets: queryTrackingWeakMarketsSchema.optional(),
  /** With `compare=previous`: the sweep compared with, or null when there is none. */
  compareRun: queryTrackingResultsRunSchema.nullable().optional(),
  /** With `group`: one entry per market or group, ordered by `sort` when given, else by key. `rows` is then empty. */
  groups: z.array(queryTrackingResultGroupSchema).optional(),
}).strict()
export type QueryTrackingResultsResponse = z.output<typeof queryTrackingResultsResponseSchema>
