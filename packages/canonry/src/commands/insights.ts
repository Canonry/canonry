import { createApiClient } from '../client.js'

export async function listInsights(
  project: string,
  opts: { dismissed?: boolean; format?: string },
): Promise<void> {
  const client = createApiClient()
  const insights = await client.getInsights(project, { dismissed: opts.dismissed })

  if (opts.format === 'json') {
    console.log(JSON.stringify(insights, null, 2))
    return
  }

  if (insights.length === 0) {
    console.log('No insights found.')
    return
  }

  for (const insight of insights) {
    const severity = insight.severity.toUpperCase().padEnd(8)
    const dismissed = insight.dismissed ? ' [dismissed]' : ''
    console.log(`${severity} ${insight.type.padEnd(12)} ${insight.title}${dismissed}`)
    if (insight.recommendation) {
      console.log(`         Action: ${insight.recommendation.action}${insight.recommendation.target ? ` → ${insight.recommendation.target}` : ''}`)
      console.log(`         Reason: ${insight.recommendation.reason}`)
    }
    if (insight.cause) {
      console.log(`         Cause: ${insight.cause.cause}${insight.cause.competitorDomain ? ` (${insight.cause.competitorDomain})` : ''}`)
    }
    console.log('')
  }
}

export async function dismissInsight(
  project: string,
  id: string,
  opts: { format?: string },
): Promise<void> {
  const client = createApiClient()
  const result = await client.dismissInsight(project, id)

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Insight ${id} dismissed.`)
}
