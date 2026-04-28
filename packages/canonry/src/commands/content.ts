import { createApiClient } from '../client.js'

interface TargetsOpts {
  limit?: number
  includeInProgress?: boolean
  format?: string
}

export async function listContentTargets(project: string, opts: TargetsOpts): Promise<void> {
  const client = createApiClient()
  const response = await client.getContentTargets(project, {
    limit: opts.limit,
    includeInProgress: opts.includeInProgress,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
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
    console.log(`${action} ${score}  conf=${conf}  ${target.query}`)
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
