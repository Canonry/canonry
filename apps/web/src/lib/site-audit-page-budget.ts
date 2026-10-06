import {
  SITE_AUDIT_MAX_PAGE_LIMIT,
  SITE_AUDIT_ONBOARDING_PAGE_LIMIT,
  formatPageCount,
  formatSiteAuditPageBudget,
  type ProjectDto,
} from '@ainyc/canonry-contracts'

/**
 * Site Health page budgets in words, shared by Project Settings (where a
 * project's budget is saved) and Site Health's Scan settings (where one scan
 * may set its own). Copy only: the server resolves which budget a scan uses.
 */

/** A page count in words: "1 page", "2,500 pages" (the shared contracts wording, as the CLI prints it). */
export const pageCountLabel = formatPageCount

/** What a saved budget of `null` means: the whole site, up to the crawler's hard limit. Sentence case of the shared wording. */
const fullSite = formatSiteAuditPageBudget(null)
export const FULL_SITE_PAGE_BUDGET_LABEL = fullSite.charAt(0).toUpperCase() + fullSite.slice(1)

/** Budgets offered by name. Any other whole number is a custom budget. */
export const PAGE_BUDGET_PRESETS: readonly { value: number; label: string }[] = [
  { value: SITE_AUDIT_ONBOARDING_PAGE_LIMIT, label: `${pageCountLabel(SITE_AUDIT_ONBOARDING_PAGE_LIMIT)} (quick look)` },
  { value: 500, label: pageCountLabel(500) },
  { value: 2_500, label: pageCountLabel(2_500) },
  { value: 10_000, label: pageCountLabel(10_000) },
]

/** A project's saved budget as Settings shows it: a preset's own name, else its page count. */
export function savedPageBudgetLabel(saved: number | null): string {
  if (saved === null) return FULL_SITE_PAGE_BUDGET_LABEL
  return PAGE_BUDGET_PRESETS.find(preset => preset.value === saved)?.label ?? pageCountLabel(saved)
}

/**
 * Scan settings' first choice sends no budget, so the server uses the project's
 * saved one. The label reads that saved value from the project; it never works
 * one out. Before the project has loaded it names no number.
 */
export function projectDefaultPageBudgetLabel(project: Pick<ProjectDto, 'siteAuditMaxPages'> | undefined): string {
  if (!project) return 'Project default'
  const saved = project.siteAuditMaxPages ?? null
  return saved === null
    ? `Project default: ${formatSiteAuditPageBudget(null)}`
    : `Project default (${formatSiteAuditPageBudget(saved)})`
}

/**
 * Scan settings' one-off "Full site" choice, offered only when the project saved a
 * smaller budget: it sends the hard limit explicitly. With no saved budget the
 * project default already is the full site, so the choice would repeat it.
 */
export function oneOffFullSiteChoice(project: Pick<ProjectDto, 'siteAuditMaxPages'> | undefined): { value: number; label: string } | null {
  return project?.siteAuditMaxPages == null ? null : { value: SITE_AUDIT_MAX_PAGE_LIMIT, label: FULL_SITE_PAGE_BUDGET_LABEL }
}
