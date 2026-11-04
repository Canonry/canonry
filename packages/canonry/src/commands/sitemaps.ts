import type { EngineSitemapsDto, SitemapCoverageResponseDto } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

const ENGINE_NAMES = { google: 'Google', bing: 'Bing' } as const

function engineLines(name: string, engine: EngineSitemapsDto | null): string[] {
  if (!engine) return [`${name}: not connected, or its list has not been read yet.`]
  const top = engine.sitemaps.filter((row) => row.parentUrl === null)
  const lines = [`${name}: ${top.length} sitemap${top.length === 1 ? '' : 's'} (${engine.sitemaps.length} with files inside indexes), read ${engine.syncedAt}`]
  for (const row of top) {
    const files = engine.sitemaps.filter((file) => file.parentUrl === row.url).length
    lines.push(`  ${row.statusLabel.padEnd(11)}${row.url}${row.isIndex ? ` (index, ${files} file${files === 1 ? '' : 's'})` : ''}${row.submittedAt ? '' : ' [found by the engine, not submitted]'}`)
  }
  if (engine.missing.length === 0) {
    lines.push('  Missing: none')
  } else {
    lines.push(`  Missing (${engine.missing.length}):`)
    for (const row of engine.missing) lines.push(`    ${row.url}  (seen in: ${row.foundIn.join(', ')})`)
  }
  return lines
}

export async function sitemapsCommand(project: string, opts: { engine?: 'google' | 'bing'; format?: string }): Promise<void> {
  const result: SitemapCoverageResponseDto = await createApiClient().sitemaps(project)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const lines = [
    result.site.scannedAt
      ? `Site: ${result.site.sitemaps.length} sitemap file${result.site.sitemaps.length === 1 ? '' : 's'} in the Site Health scan of ${result.site.scannedAt}`
      : 'Site: no Site Health scan yet, so only the engines are compared.',
  ]
  for (const engine of opts.engine ? [opts.engine] : (['google', 'bing'] as const)) {
    lines.push('', ...engineLines(ENGINE_NAMES[engine], result[engine]))
  }
  console.log(lines.join('\n'))
}
