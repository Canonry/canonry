import {
  RatioUnits,
  TrendUnits,
  formatPercent,
  formatSignedPointDelta,
  type MetricsWindow,
  type TrendFigure,
  type TrendSurface,
} from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

const SURFACE_TITLES: Record<TrendSurface, string> = {
  'index-coverage': 'Index coverage',
  'site-health': 'Site Health',
  backlinks: 'Backlinks',
}

function formatReading(figure: TrendFigure, value: number): string {
  return figure.unit === TrendUnits.fraction ? formatPercent(value, RatioUnits.fraction) : value.toLocaleString('en-US')
}

/** The server's change in words: shares move in points, everything else in its own unit. */
function formatChange(figure: TrendFigure): string {
  if (figure.change === null) return figure.value === null ? 'no reading in the window' : 'one reading in the window'
  const { difference, basis } = figure.change
  const amount = figure.unit === TrendUnits.fraction
    ? formatSignedPointDelta(difference, RatioUnits.fraction)
    : `${difference > 0 ? '+' : ''}${difference.toLocaleString('en-US')}`
  return `${amount} since ${basis.date}`
}

/** `canonry trends <project> --surface <surface>`: one dashboard trend card. An object command, so jsonl degrades to the json document. */
export async function trendsCommand(
  project: string,
  opts: { surface: TrendSurface; window?: MetricsWindow; format?: string },
): Promise<void> {
  const result = await createApiClient().getTrends(project, { surface: opts.surface, window: opts.window })
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const title = SURFACE_TITLES[result.surface]
  if (result.groups.length === 0 || result.startDate === null) {
    console.log(`${title} for "${project}": nothing recorded yet.`)
    return
  }
  console.log(`${title} for "${project}", ${result.startDate} to ${result.endDate} (window ${result.window}):\n`)
  const labelWidth = Math.max(...result.groups.flatMap(group => group.figures.map(figure => figure.label.length))) + 2
  for (const group of result.groups) {
    console.log(`  ${group.label}`)
    for (const figure of group.figures) {
      const value = figure.value === null ? '—' : formatReading(figure, figure.value)
      console.log(`    ${figure.label.padEnd(labelWidth)}${value.padStart(10)}  ${formatChange(figure)}`)
    }
  }
}
