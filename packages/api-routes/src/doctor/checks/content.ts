import { eq } from 'drizzle-orm'
import { projects } from '@ainyc/canonry-db'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
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

    const coveredDomains = citedDomains.filter((domain) => input.domainClasses.has(domain))
    const unclassifiedDomains = citedDomains.filter((domain) => !input.domainClasses.has(domain))
    const coverage = coveredDomains.length / citedDomains.length
    const details = {
      citedSurfaceDomainCount: citedDomains.length,
      classifiedDomainCount: input.domainClasses.size,
      coveredDomainCount: coveredDomains.length,
      coverage,
      threshold: WINNABILITY_COVERAGE_WARN_THRESHOLD,
      unclassifiedDomains: unclassifiedDomains.slice(0, UNCLASSIFIED_DOMAIN_SAMPLE_LIMIT),
    }

    if (coveredDomains.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'content.winnability.no-classifications',
        summary: `0 of ${citedDomains.length} cited-surface domain(s) have discovery classifications; the winnability gate is failing open.`,
        remediation: `Run \`canonry discover run ${ctx.project.name} --wait\` to classify cited domains before trusting ownable/ceded content targets.`,
        details,
      }
    }

    if (coverage < WINNABILITY_COVERAGE_WARN_THRESHOLD) {
      return {
        status: CheckStatuses.warn,
        code: 'content.winnability.low-coverage',
        summary: `${coveredDomains.length} of ${citedDomains.length} cited-surface domain(s) classified (${percent(coverage)}%); the winnability gate may miss ceded surfaces.`,
        remediation: `Run \`canonry discover run ${ctx.project.name} --wait\` to raise classification coverage before relying on ownable/ceded content targets.`,
        details,
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'content.winnability.covered',
      summary: `${coveredDomains.length} of ${citedDomains.length} cited-surface domain(s) classified (${percent(coverage)}%); the winnability gate is active.`,
      remediation: null,
      details,
    }
  },
}

export const CONTENT_CHECKS: readonly CheckDefinition[] = [winnabilityCoverageCheck]

export const CONTENT_CHECK_BY_ID = Object.fromEntries(
  CONTENT_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
