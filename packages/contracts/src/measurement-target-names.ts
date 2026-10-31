import { MIN_DOMAIN_BRAND_KEY_LENGTH, usableBrandAliases } from './answer-visibility.js'
import { brandKeyFromText, compileBrandAliases, matcherMatchesText } from './brand-matching.js'

/**
 * A Property name as Advanced Measurement reads it: NFKC, lowercased, split into
 * runs of letters and digits. The report's mention matcher and the publish check
 * on qualified names both tokenize through this, so an editor that warns about a
 * name and the engine that matches it cannot disagree about its words.
 */
export function measurementNameWords(value: string): string[] {
  // Unicode's default lowercasing is locale-independent and matches the en
  // mapping used here; avoid invoking locale resolution for every answer.
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** The exact token identity two Property names are compared by. */
export function measurementNameKey(value: string): string {
  return measurementNameWords(value).join('\u0000')
}

/**
 * Whether a qualified name contains one of the Property's names as whole words
 * plus at least one more word. Publishing refuses a qualified name that does
 * not: it could never confirm a mention the plain name had not already found.
 */
export function qualifiedNameIncludesName(qualifiedName: string, names: readonly string[]): boolean {
  const qualifiedKey = measurementNameKey(qualifiedName)
  return names
    .map(measurementNameKey)
    .filter(Boolean)
    .some(nameKey => nameKey !== qualifiedKey && `\u0000${qualifiedKey}\u0000`.includes(`\u0000${nameKey}\u0000`))
}

/**
 * The shortest Property name worth matching, in letters and digits. Sitemap
 * discovery applies the same floor before it seeds a page label as a name.
 */
export const MEASUREMENT_TARGET_NAME_MIN_KEY_LENGTH = MIN_DOMAIN_BRAND_KEY_LENGTH

export const MeasurementTargetNameIssueCodes = {
  /** Under the name floor: short tokens match unrelated words. */
  short: 'target-name-short',
  /** No project brand name in it: other places with the same name can match. */
  withoutBrand: 'target-name-without-brand',
  /** A qualified name with no stored name inside it; publishing refuses it. */
  qualifiedWithoutName: 'target-qualified-name-without-name',
} as const
export type MeasurementTargetNameIssueCode = typeof MeasurementTargetNameIssueCodes[keyof typeof MeasurementTargetNameIssueCodes]

export interface MeasurementTargetNameIssue {
  code: MeasurementTargetNameIssueCode
  /** `aliases` are a Property's names; `identityAliases` its qualified names. */
  field: 'aliases' | 'identityAliases'
  index: number
  value: string
}

/**
 * Advisory checks on the names an operator gives a Property. At most one issue
 * per entry, the most specific first. `brandNames` are the project's brand
 * names; with none usable, the brand check is skipped rather than flagging every
 * name. Nothing here blocks a save: the publish review owns refusals.
 */
export function measurementTargetNameIssues(input: {
  aliases: readonly string[]
  identityAliases?: readonly string[]
  brandNames: readonly string[]
}): MeasurementTargetNameIssue[] {
  const brands = usableBrandAliases(input.brandNames)
  const brandMatcher = brands.length > 0 ? compileBrandAliases(brands) : null
  const issues: MeasurementTargetNameIssue[] = []
  input.aliases.forEach((value, index) => {
    if (!value.trim()) return
    if (brandKeyFromText(value).length < MEASUREMENT_TARGET_NAME_MIN_KEY_LENGTH) {
      issues.push({ code: MeasurementTargetNameIssueCodes.short, field: 'aliases', index, value })
    } else if (brandMatcher !== null && !matcherMatchesText(brandMatcher, value)) {
      issues.push({ code: MeasurementTargetNameIssueCodes.withoutBrand, field: 'aliases', index, value })
    }
  })
  input.identityAliases?.forEach((value, index) => {
    if (!value.trim()) return
    if (!qualifiedNameIncludesName(value, input.aliases)) {
      issues.push({ code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index, value })
    }
  })
  return issues
}

/** One plain sentence per issue, shared by the draft API's warnings and the dashboard editor. */
export function measurementTargetNameIssueMessage(issue: MeasurementTargetNameIssue): string {
  switch (issue.code) {
    case MeasurementTargetNameIssueCodes.short:
      return `"${issue.value.trim()}" is too short to match safely. A name needs at least ${MEASUREMENT_TARGET_NAME_MIN_KEY_LENGTH} letters or numbers, or it can match unrelated words in an answer.`
    case MeasurementTargetNameIssueCodes.withoutBrand:
      return `"${issue.value.trim()}" does not include your brand name, so answers about other places with this name can count for this property.`
    case MeasurementTargetNameIssueCodes.qualifiedWithoutName:
      return `"${issue.value.trim()}" must include one of this property's names plus more words, such as a street or city. Publishing is refused until it does.`
  }
}
