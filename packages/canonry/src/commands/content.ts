import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'
import { isMachineFormat, CliError } from '../cli-error.js'
import type { CheckResultDto, RecommendationBriefDto, WinnabilityClass } from '@ainyc/canonry-contracts'

const WINNABILITY_COVERAGE_CHECK_ID = 'content.winnability.coverage'

interface TargetsOpts {
  limit?: number
  includeInProgress?: boolean
  winnabilityClass?: WinnabilityClass
  ownable?: boolean
  format?: string
}

export async function listContentTargets(project: string, opts: TargetsOpts): Promise<void> {
  const client = createApiClient()
  const response = await client.getContentTargets(project, {
    limit: opts.limit,
    includeInProgress: opts.includeInProgress,
    winnabilityClass: opts.winnabilityClass,
    ownable: opts.ownable,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (opts.format === 'jsonl') {
    // One self-contained target per line. Prepend the envelope context the row
    // loses — `project` and the run it was computed from — then spread the row
    // last so its own fields win.
    emitJsonl(
      response.targets.map(target => ({
        project,
        latestRunId: response.contextMetrics.latestRunId,
        ...target,
      })),
    )
    return
  }

  if (response.targets.length === 0) {
    console.log('No content targets surfaced. (Run `canonry run` to generate fresh signal.)')
    return
  }

  console.log(
    `${response.targets.length} target${response.targets.length === 1 ? '' : 's'}` +
      ` (latestRunId=${response.contextMetrics.latestRunId})`,
  )
  console.log('')
  for (const target of response.targets) {
    const action = target.action.toUpperCase().padEnd(11)
    const score = target.score.toFixed(1).padStart(6)
    const conf = target.actionConfidence.padEnd(6)
    const surface = target.winnabilityClass === 'ceded' ? 'CEDED  ' : 'ownable'
    console.log(`${action} ${score}  conf=${conf}  [${surface}]  ${target.query}`)
    if (target.ourBestPage) {
      const posLabel =
        target.ourBestPage.gscAvgPosition !== null
          ? `pos #${target.ourBestPage.gscAvgPosition}`
          : 'no GSC ranking'
      console.log(`            our page: ${target.ourBestPage.url} (${posLabel})`)
    }
    if (target.winningCompetitor) {
      console.log(`            winning:  ${target.winningCompetitor.url} (${target.winningCompetitor.citationCount}× cited)`)
    }
    if (target.drivers.length > 0) {
      console.log(`            why:      ${target.drivers.join(' · ')}`)
    }
    if (target.existingAction) {
      console.log(`            in-flight action: ${target.existingAction.actionId} (${target.existingAction.state})`)
    }
    console.log('')
  }
}

export async function listContentSources(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  const response = await client.getContentSources(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (opts.format === 'jsonl') {
    // One self-contained source row per line. Prepend `project` so a line lifted
    // out of the envelope still says which project it describes; the row's own
    // fields win on spread.
    emitJsonl(response.sources.map(row => ({ project, ...row })))
    return
  }

  if (response.sources.length === 0) {
    console.log('No grounding sources captured yet.')
    return
  }

  for (const row of response.sources) {
    console.log(`Q: ${row.query}`)
    if (row.groundingSources.length === 0) {
      console.log('   (no grounding sources)')
    } else {
      for (const g of row.groundingSources) {
        const tag = g.isOurDomain ? 'OURS    ' : g.isCompetitor ? 'COMP    ' : 'OTHER   '
        console.log(`   ${tag} ${g.uri} (${g.citationCount}×)`)
      }
    }
    console.log('')
  }
}

export async function listContentGaps(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  const response = await client.getContentGaps(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (opts.format === 'jsonl') {
    // One self-contained gap row per line. Prepend `project` so the line stands
    // alone; the row's own fields win on spread.
    emitJsonl(response.gaps.map(gap => ({ project, ...gap })))
    return
  }

  if (response.gaps.length === 0) {
    console.log('No competitor-only-cited queries detected.')
    return
  }

  console.log(`${response.gaps.length} gap${response.gaps.length === 1 ? '' : 's'} found`)
  console.log('')
  for (const gap of response.gaps) {
    const missPct = Math.round(gap.missRate * 100)
    console.log(`${missPct.toString().padStart(3)}%  ${gap.competitorCount} competitor(s)  ${gap.query}`)
    console.log(`       competitors: ${gap.competitorDomains.join(', ')}`)
    console.log('')
  }
}

interface BriefOpts {
  provider?: string
  model?: string
  force?: boolean
  format?: string
}

export async function generateContentBrief(project: string, targetRef: string, opts: BriefOpts): Promise<void> {
  const client = createApiClient()
  await warnIfWinnabilityCoverageIsLow(client, project, opts.format)
  const response = await client.synthesizeContentBrief(project, targetRef, {
    provider: opts.provider,
    model: opts.model,
    forceRefresh: opts.force,
  })

  // Object command — jsonl degrades to the json document (no streamable collection).
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  const b = response.brief
  console.log(`Brief for: ${b.targetQuery}`)
  console.log(`Surface:   ${b.winnabilityClass}`)
  console.log(`Provider:  ${response.provider} / ${response.model}`)
  console.log('')
  console.log(`Angle:               ${b.angle}`)
  console.log(`Why winnable:        ${b.whyWinnable}`)
  console.log(`Schema hookup:       ${b.schemaHookup}`)
  console.log(`Controllable surface: ${b.controllableSurfaceRationale}`)
}

/** Fetch a cached brief, returning null when none exists (404). */
async function tryGetBrief(
  client: ReturnType<typeof createApiClient>,
  project: string,
  targetRef: string,
): Promise<RecommendationBriefDto | null> {
  try {
    return await client.getContentBrief(project, targetRef)
  } catch (err) {
    if (err instanceof CliError && err.code === 'NOT_FOUND') return null
    throw err
  }
}

export async function contentMap(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  await warnIfWinnabilityCoverageIsLow(client, project, opts.format)
  // The winnability map: which cited surfaces are ceded, and which queries are
  // ownable. One operator one-shot over the two reads that back the gate.
  const [classifications, targets] = await Promise.all([
    client.getDomainClassifications(project),
    client.getContentTargets(project, { ownable: true }),
  ])

  // Attach each ownable target's cached brief (if one was already synthesized).
  const ownable = await Promise.all(
    targets.targets.map(async (target) => ({
      ...target,
      brief: (await tryGetBrief(client, project, target.targetRef))?.brief ?? null,
    })),
  )

  if (opts.format === 'json') {
    console.log(JSON.stringify({ classifications: classifications.classifications, ownable }, null, 2))
    return
  }
  if (opts.format === 'jsonl') {
    // Primary collection: the ranked ownable targets (each carries its brief).
    emitJsonl(ownable.map((row) => ({ project, ...row })))
    return
  }

  const ceded = classifications.classifications.filter(
    (c) => c.competitorType === 'ota-aggregator' || c.competitorType === 'editorial-media',
  )
  console.log(
    `${classifications.classifications.length} domain(s) classified` +
      ` (${ceded.length} ceded surface${ceded.length === 1 ? '' : 's'}) · ${ownable.length} ownable target(s)`,
  )
  console.log('')
  for (const row of ownable) {
    const score = row.score.toFixed(1).padStart(6)
    const briefMark = row.brief ? 'brief ✓' : 'brief —'
    console.log(`${score}  ${briefMark}  ${row.query}`)
    if (row.brief) {
      console.log(`        angle: ${row.brief.angle}`)
    }
  }
}

function shouldWarn(check: CheckResultDto | undefined): check is CheckResultDto {
  return check?.status === 'warn' || check?.status === 'fail'
}

async function warnIfWinnabilityCoverageIsLow(
  client: ReturnType<typeof createApiClient>,
  project: string,
  format: string | undefined,
): Promise<void> {
  if (isMachineFormat(format)) return

  let check: CheckResultDto | undefined
  try {
    const report = await client.runDoctor({ project, checkIds: [WINNABILITY_COVERAGE_CHECK_ID] })
    check = report.checks.find((candidate) => candidate.id === WINNABILITY_COVERAGE_CHECK_ID)
  } catch {
    // Soft nudge only. Content commands should still work against older servers
    // or transient doctor failures.
    return
  }
  if (!shouldWarn(check)) return

  const remediation = check.remediation ? ` ${check.remediation}` : ''
  console.error(`Warning: ${check.summary}${remediation}`)
}
