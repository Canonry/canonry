import { eq } from 'drizzle-orm'
import { projects } from '@ainyc/canonry-db'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  classifyCitedSurface,
} from '@ainyc/canonry-contracts'
import { loadOrchestratorInput } from '../../content-data.js'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

const WINNABILITY_COVERAGE_WARN_THRESHOLD = 0.8
const UNCLASSIFIED_DOMAIN_SAMPLE_LIMIT = 10

function skippedNoProject(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'content.winnability.no-project',
    summary: 'Project context required for content winnability checks.',
    remediation: 'Run `canonry doctor --project <name>` to scope this check to a project.',
  }
}

function loadProject(ctx: DoctorContext) {
  if (!ctx.project) return null
  return ctx.db
    .select()
    .from(projects)
    .where(eq(projects.id, ctx.project.id))
    .get() ?? null
}

function percent(value: number): number {
  return Math.round(value * 100)
}

const winnabilityCoverageCheck: CheckDefinition = {
  id: 'content.winnability.coverage',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Content winnability classification coverage',
  run: (ctx: DoctorContext): CheckOutput => {
    if (!ctx.project) return skippedNoProject()

    const project = loadProject(ctx)
    if (!project) {
      return {
        status: CheckStatuses.fail,
        code: 'content.winnability.project-missing',
        summary: 'Project row disappeared before the content winnability check could run.',
        remediation: 'Re-run `canonry doctor --project <name>`; if this persists, inspect the local database.',
      }
    }

    const input = loadOrchestratorInput(ctx.db, project)
    const citationCounts = new Map<string, number>()
    for (const candidate of input.candidateQueries) {
      for (const cited of candidate.citedSurfaceDomains) {
        citationCounts.set(cited.domain, (citationCounts.get(cited.domain) ?? 0) + cited.citationCount)
      }
    }

    const citedDomains = [...citationCounts.keys()].sort()
    if (citedDomains.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'content.winnability.no-cited-surface',
        summary: 'No non-owned cited-surface domains in recent content evidence, so the winnability gate has nothing to classify yet.',
        remediation: `Run \`canonry run ${ctx.project.name}\` to capture fresh answer-engine citations before checking discovery coverage.`,
        details: {
          citedSurfaceDomainCount: 0,
          classifiedDomainCount: input.domainClasses.size,
        },
      }
    }

    // Recognize cited domains through the SAME classifier the gate uses
    // (own > competitor > stored discovery > static allow-list), not just the
    // discovery-stored subset. Otherwise the check under-reports coverage for
    // the well-known aggregators/editorial the allow-list already recognizes.
    const surfaceClasses = classifyCitedSurface(
      citedDomains.map((domain) => ({ domain })),
      { projectDomains: [input.ownDomain], competitorDomains: input.competitors },
      input.domainClasses,
    )
    const coveredDomains = citedDomains.filter((domain) => surfaceClasses.has(domain))
    const unclassifiedDomains = citedDomains.filter((domain) => !surfaceClasses.has(domain))
    const coverage = coveredDomains.length / citedDomains.length
    const details = {
      citedSurfaceDomainCount: citedDomains.length,
      coveredDomainCount: coveredDomains.length,
      classifiedDomainCount: input.domainClasses.size,
      coverage,
      threshold: WINNABILITY_COVERAGE_WARN_THRESHOLD,
      unclassifiedDomains: unclassifiedDomains.slice(0, UNCLASSIFIED_DOMAIN_SAMPLE_LIMIT),
    }

    // Discovery is what classifies the unrecognized tail, but it requires an
    // ICP. If the project has none, surface that first so the operator doesn't
    // follow the "run discovery" remediation straight into an ICP error.
    const hasIcp = Boolean(project.icpDescription && project.icpDescription.trim().length > 0)
    const discoverRemediation = hasIcp
      ? `Run \`canonry discover run ${ctx.project.name} --wait\` to classify the unrecognized domains before relying on ownable/ceded content targets.`
      : `This project has no ICP, which discovery requires. Run \`canonry discover run ${ctx.project.name} --icp "<who the project sells to>" --wait\` (or set \`spec.icpDescription\`) to classify the unrecognized domains.`

    if (coveredDomains.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'content.winnability.no-classifications',
        summary: `0 of ${citedDomains.length} cited-surface domain(s) are recognized (own/competitor/aggregator/editorial); the winnability gate is failing open.`,
        remediation: discoverRemediation,
        details,
      }
    }

    if (coverage < WINNABILITY_COVERAGE_WARN_THRESHOLD) {
      return {
        status: CheckStatuses.warn,
        code: 'content.winnability.low-coverage',
        summary: `${coveredDomains.length} of ${citedDomains.length} cited-surface domain(s) recognized (${percent(coverage)}%); the winnability gate may miss ceded surfaces in the unrecognized tail.`,
        remediation: discoverRemediation,
        details,
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'content.winnability.covered',
      summary: `${coveredDomains.length} of ${citedDomains.length} cited-surface domain(s) recognized (${percent(coverage)}%); the winnability gate is active.`,
      remediation: null,
      details,
    }
  },
}

export const CONTENT_CHECKS: readonly CheckDefinition[] = [winnabilityCoverageCheck]

export const CONTENT_CHECK_BY_ID = Object.fromEntries(
  CONTENT_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
