import { z } from 'zod'
import { brandKeyFromText, compileBrandAliases, matcherMatchesText, type BrandAliasMatcher } from './brand-matching.js'

/**
 * BRANDED VS NON-BRAND IS THE SAME SPLIT EVERYWHERE.
 *
 * A query that names the project's own brand measures recognition: the model is
 * being asked about you, so a mention is nearly free and a competitor
 * structurally cannot earn one. A query that does not name you measures
 * competitive placement. Pooling the two into one denominator lets branded
 * recall carry a category number, which inverts the ranking it claims to show —
 * so the two never share a denominator in any metric, copy, or contract field.
 *
 * Advanced measurement reached this first and stores the class per assignment
 * (`measurementQueryClassSchema`, a re-export of this enum). Projects without a
 * measurement plan have no stored class, so read-time surfaces classify from
 * the query text with {@link compileQueryClassifier} — the SAME brand matcher,
 * never a second copy of the rules.
 */
export const QUERY_CLASSES = ['branded', 'non-brand'] as const

export const queryClassSchema = z.enum(QUERY_CLASSES)

export type QueryClass = z.infer<typeof queryClassSchema>

/** `all` keeps both classes visible side by side; it never pools them into one figure. */
export const queryClassFilterSchema = z.enum(['all', 'branded', 'non-brand'])

export type QueryClassFilter = z.infer<typeof queryClassFilterSchema>

export interface QueryClassifier {
  readonly matcher: BrandAliasMatcher
  /** `branded` when an approved brand alias appears in the query as complete adjacent words. */
  classify(queryText: string | null | undefined): QueryClass
}

/**
 * Compile a project's brand aliases into a reusable query classifier.
 *
 * Returns `null` when no alias survives compilation — a project with no display
 * name and no usable domain brand cannot be classified against, and answering
 * `non-brand` for every query there would be a claim the data does not support.
 * Callers must treat `null` as "classification unavailable" and say so rather
 * than presenting an unsplit number under a non-brand label.
 *
 * Compiled once per project rather than per query: the alias set is small and
 * the query basket is not, and `compileBrandAliases` exists precisely so one
 * list can be reused across many texts.
 */
export function compileQueryClassifier(brandNames: readonly string[]): QueryClassifier | null {
  const usable = brandNames.filter(name => brandKeyFromText(name).length > 0)
  if (usable.length === 0) return null
  const matcher = compileBrandAliases(usable)
  if (matcher.keys.size === 0) return null
  return {
    matcher,
    classify(queryText) {
      return matcherMatchesText(matcher, queryText) ? 'branded' : 'non-brand'
    },
  }
}

/**
 * One-shot classification. Prefer {@link compileQueryClassifier} when
 * classifying a whole basket — this recompiles the alias set on every call.
 */
export function classifyQueryClass(
  queryText: string | null | undefined,
  brandNames: readonly string[],
): QueryClass | null {
  return compileQueryClassifier(brandNames)?.classify(queryText) ?? null
}

/** A query as it was requested, with the class the server reports for it. */
export interface ReportedQueryClass {
  query: string
  /**
   * `null` is the server saying no single class exists. Absent means the server
   * said nothing: it predates the field, or it returned no such row.
   */
  queryClass?: QueryClass | null
}

/**
 * Read back the class the server reports for each requested query text, from
 * the rows a `/queries` read or write returns. This looks a class up; it never
 * derives one. One entry per distinct text, in request order. An entry carries
 * `queryClass` only when the server sent one for that text (a class, or `null`),
 * so "not reported" is never turned into the server's "no single class".
 */
export function reportedQueryClasses(
  requested: readonly string[],
  rows: ReadonlyArray<{ query: string; queryClass?: QueryClass | null }>,
): ReportedQueryClass[] {
  const classByText = new Map(rows.map(row => [row.query, row.queryClass]))
  return [...new Set(requested)].map((query) => {
    const queryClass = classByText.get(query)
    return queryClass === undefined ? { query } : { query, queryClass }
  })
}
