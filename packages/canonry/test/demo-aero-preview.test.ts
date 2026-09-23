import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aeroPreviewResponseSchema, aeroPreviewStarterIds, type AeroPreviewResponse } from '@ainyc/canonry-contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoServer } from '../src/demo-server.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

// A seed date far from the one the turns were drafted against, so a hardcoded
// date or a number copied from a different seed shows up as a failure.
const NOW = new Date('2026-03-05T12:00:00.000Z')
const PROJECTS = ['summit-roofing', 'harbor-resorts'] as const
type ProjectName = (typeof PROJECTS)[number]
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const ENGINES = { openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude' } as const
const day = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso))
const ratio = (value: { numerator: number; denominator: number }) => `${value.numerator}/${value.denominator}`

const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-aero-preview-'))
let app: Awaited<ReturnType<typeof createDemoServer>>
// Installed before the demo is built, so building the previews is covered too.
const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Demo must not use the network') })
let visitor = 0
const inject = (options: { url: string; method?: 'GET' | 'POST' | 'DELETE'; payload?: object }) => {
  visitor += 1
  return app.inject({ ...options, headers: { 'x-forwarded-for': `10.9.${(visitor >> 8) & 255}.${visitor & 255}` } })
}
const read = async (url: string): Promise<Json> => {
  const response = await inject({ url })
  expect(response.statusCode, `${url}: ${response.body.slice(0, 200)}`).toBe(200)
  return response.json()
}
const report = async (project: ProjectName, query: string) => (await read(`/api/v1/projects/${project}/visibility-report?${query}`)).populations[0]
const previews = new Map<ProjectName, AeroPreviewResponse>()
const answer = (project: ProjectName, id: (typeof aeroPreviewStarterIds)[number]) => previews.get(project)!.starters.find(starter => starter.id === id)!.answer

beforeAll(async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  app = await createDemoServer({ assetsDir: dir, now: NOW })
  for (const project of PROJECTS) {
    previews.set(project, aeroPreviewResponseSchema.parse(await read(`/api/v1/projects/${project}/agent/preview`)))
  }
}, 60_000)
afterAll(async () => { await app?.close(); network.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

describe('scripted Aero preview on the public demo', () => {
  it.each(PROJECTS)('serves the four dashboard starters for %s under the shared contract', async project => {
    const preview = previews.get(project)!
    expect(preview.project).toBe(project)
    expect(preview.seededAt).toBe(NOW.toISOString())
    expect(preview.seededAt).toBe((await read('/api/v1/demo')).seededAt)
    expect(preview.starters.map(starter => starter.id)).toEqual([...aeroPreviewStarterIds])
  })

  it.each(PROJECTS)('uses registered read tools with their real titles and valid arguments for %s', project => {
    for (const starter of previews.get(project)!.starters) {
      expect(starter.steps.length, starter.id).toBeGreaterThanOrEqual(1)
      expect(starter.steps.length, starter.id).toBeLessThanOrEqual(3)
      for (const { tool } of starter.steps) {
        const registered = canonryMcpTools.find(candidate => candidate.name === tool.name)
        expect(registered, tool.name).toBeDefined()
        expect(registered!.access, tool.name).toBe('read')
        expect(tool.label).toBe(registered!.title)
        expect(registered!.inputSchema.safeParse(tool.arguments).success, tool.name).toBe(true)
        expect(tool.durationMs).toBeGreaterThanOrEqual(300)
        expect(tool.durationMs).toBeLessThanOrEqual(1500)
      }
    }
  })

  it.each(PROJECTS)('keeps the %s copy in Aero voice and the dashboard vocabulary', async project => {
    const serialized = JSON.stringify(previews.get(project))
    expect(serialized).not.toMatch(/\u2014/)
    expect(serialized).not.toMatch(/\bquestions?\b/i)
    for (const starter of previews.get(project)!.starters) {
      expect(starter.answer).not.toMatch(/^#/m)
      expect(starter.answer).not.toMatch(/^---$/m)
      expect(starter.answer.match(/^\|---/gm)?.length ?? 0, starter.id).toBeLessThanOrEqual(1)
      expect(starter.answer, starter.id).toMatch(/\n\nNext: /)
      const links = [...starter.answer.matchAll(/\]\((?<path>[^)]+)\)/g)].map(match => match.groups!.path!)
      expect(links.length, starter.id).toBeGreaterThanOrEqual(1)
      expect(links.length, starter.id).toBeLessThanOrEqual(2)
      for (const path of links) {
        expect(path.startsWith(`/projects/${project}`), path).toBe(true)
        const document = await inject({ url: path })
        expect(document.statusCode, path).toBe(200)
        expect(document.headers['content-type'], path).toContain('text/html')
      }
    }
  })

  it.each(PROJECTS)('dates the %s turns from its seeded sweeps, not a fixed calendar', async project => {
    const sweeps = (await read(`/api/v1/projects/${project}/runs?kind=answer-visibility`) as Json[])
      .map(run => run.createdAt as string)
      .sort()
    const latest = day(sweeps.at(-1)!)
    const previous = day(sweeps.at(-2)!)
    expect(latest).toBe('Mar 5')
    expect(previous).toBe('Feb 26')
    expect(answer(project, 'status')).toContain(`Latest sweep: ${latest}`)
    expect(answer(project, 'changes')).toContain(`**${latest} vs ${previous}`)
    expect(JSON.stringify(previews.get(project))).not.toMatch(/\b(?:Aug|Sep)\b/)
  })

  it('states the Summit status numbers the visibility report serves', async () => {
    const status = answer('summit-roofing', 'status')
    const branded = await report('summit-roofing', 'queryClass=branded')
    const nonBrand = await report('summit-roofing', 'queryClass=non-brand')
    expect(status).toContain(`| Branded (${branded.summary.queryCount}) | ${ratio(branded.summary.mentionCoverage)} | ${ratio(branded.summary.citationCoverage)} |`)
    const percent = (value: { rate: number }) => Math.round(value.rate * 100)
    expect(status).toContain(`| Non-brand (${nonBrand.summary.queryCount}) | ${ratio(nonBrand.summary.mentionCoverage)} (${percent(nonBrand.summary.mentionCoverage)}%) | ${ratio(nonBrand.summary.citationCoverage)} (${percent(nonBrand.summary.citationCoverage)}%) |`)
    for (const [provider, name] of Object.entries(ENGINES)) {
      const engine = await report('summit-roofing', `queryClass=non-brand&provider=${provider}`)
      expect(status).toContain(`${name} ${ratio(engine.summary.mentionCoverage)} and ${ratio(engine.summary.citationCoverage)}`)
    }
  })

  it('states the Summit changes the visibility report compares', async () => {
    const changes = answer('summit-roofing', 'changes')
    const movement = (current: { numerator: number; denominator: number }, previous: { numerator: number; denominator: number }) => current.numerator === previous.numerator
      ? `${ratio(current)}, unchanged`
      : `${ratio(current)}, ${current.numerator > previous.numerator ? 'up' : 'down'} from ${ratio(previous)}`
    for (const [queryClass, label] of [['non-brand', 'Non-brand'], ['branded', 'Branded']] as const) {
      const population = await report('summit-roofing', `queryClass=${queryClass}`)
      expect(population.comparison.state).toBe('available')
      expect(population.comparison.previousRun.id).toBe('demo-summit-week-5')
      expect(changes).toContain(`- ${label}: ${movement(population.summary.mentionCoverage, population.comparison.mentionCoverage.previous)}.`)
      expect(changes).toContain(`- ${label}: ${movement(population.summary.citationCoverage, population.comparison.citationCoverage.previous)}.`)
      if (queryClass === 'non-brand') {
        expect(changes).toContain(`(${population.trend.map((point: Json) => point.mentionCoverage.numerator).join(', ')})`)
      }
    }
    const openai = await report('summit-roofing', 'queryClass=non-brand&provider=openai')
    expect(changes).toContain(`OpenAI: its non-brand mentions have not dropped in ${openai.trend.length} sweeps (${openai.trend.map((point: Json) => point.mentionCoverage.numerator).join(', ')} of ${openai.summary.answerCount})`)
    expect(changes).toContain('Within normal run-to-run noise')
    expect(changes).not.toContain('Bigger than normal run-to-run noise')
  })

  it('grounds the Summit gaps and insights in the stored answers and insights', async () => {
    const gaps = answer('summit-roofing', 'gaps')
    const nonBrand = await report('summit-roofing', 'queryClass=non-brand')
    const unnamed = new Set<string>()
    const byQuery = new Map<string, number>()
    for (const row of nonBrand.queries.items as Json[]) byQuery.set(row.query, (byQuery.get(row.query) ?? 0) + row.mentionCoverage.numerator)
    for (const [query, mentioned] of byQuery) if (mentioned === 0) unnamed.add(query)
    expect(unnamed.size).toBeGreaterThan(0)
    expect(gaps).toContain(`**${unnamed.size} of ${byQuery.size} non-brand queries are named by no engine`)
    for (const query of unnamed) expect(gaps).toContain(`| ${query} | RoofCraft, by 3 of 3 engines |`)

    const insights = answer('summit-roofing', 'insights')
    const stored = await read('/api/v1/projects/summit-roofing/insights') as Json[]
    expect(insights).toContain(`None of the ${stored.length} active insights is high or critical`)
    const latest = stored.filter(row => row.runId === 'demo-summit-week-6')
    for (const row of latest.filter(item => item.severity === 'medium')) expect(insights).toContain(`"${row.query}"`)
    expect(insights).toContain(`added ${latest.length}, ${latest.filter(row => row.severity === 'medium').length} medium`)
  })

  it('says an engine cites a competitor only where that engine\'s answer cites the competitor\'s domain', async () => {
    const run = await read('/api/v1/runs/demo-summit-week-6')
    const competitors = (await read('/api/v1/projects/summit-roofing/competitors') as Json[]).map(row => row.domain as string)
    const providerOf = Object.fromEntries(Object.entries(ENGINES).map(([id, name]) => [name, id]))
    let checked = 0
    for (const id of ['gaps', 'insights'] as const) {
      for (const line of answer('summit-roofing', id).split('\n')) {
        const query = line.match(/"([^"]+)"/)?.[1]
        for (const match of line.matchAll(/((?:OpenAI|Gemini|Claude)(?:(?:, | and )(?:OpenAI|Gemini|Claude))*) cites? (RoofCraft|Everlast Roofing) instead/g)) {
          expect(query, line).toBeDefined()
          const domain = `${match[2]!.toLowerCase().replace(/\s+/g, '-')}.example`
          expect(competitors).toContain(domain)
          for (const engine of match[1]!.split(/, | and /)) {
            const snapshot = (run.snapshots as Json[]).find(row => row.query === query && row.provider === providerOf[engine])
            expect(snapshot?.citedDomains, `${engine} on "${query}"`).toContain(domain)
            checked += 1
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('counts the Harbor gaps from the stored answers', async () => {
    const run = await read('/api/v1/runs/demo-harbor-week-6')
    const snapshots = run.snapshots as Json[]
    const geminiCoastal = snapshots.filter(row => row.provider === 'gemini' && !/reviews$/.test(row.query) && (row.answerText as string).includes('Coastal Stays') && !row.answerMentioned).length
    const seaside = snapshots.filter(row => /reviews$/.test(row.query) && (row.answerText as string).includes('Seaside Collection') && !row.answerMentioned).length
    const gaps = answer('harbor-resorts', 'gaps')
    expect(geminiCoastal).toBeGreaterThan(0)
    expect(gaps).toContain(`Gemini names Coastal Stays instead of Harbor on all of them, ${geminiCoastal} in total`)
    expect(gaps).toContain(`: ${seaside} in total`)
  })

  it('states the Harbor numbers the visibility report, changes and site audit serve', async () => {
    const status = answer('harbor-resorts', 'status')
    for (const queryClass of ['branded', 'non-brand']) {
      const population = await report('harbor-resorts', `queryClass=${queryClass}`)
      const engines = []
      for (const provider of Object.keys(ENGINES)) engines.push(ratio((await report('harbor-resorts', `queryClass=${queryClass}&provider=${provider}`)).summary.mentionCoverage))
      expect(status).toContain(`| ${ratio(population.summary.mentionCoverage)} | ${ratio(population.summary.citationCoverage)} | ${engines.join(' | ')} |`)
    }
    const gemini = await report('harbor-resorts', 'queryClass=non-brand&provider=gemini')
    expect(gemini.summary.mentionCoverage.numerator).toBe(0)
    expect(status).toContain(`Gemini named Harbor on 0 of ${gemini.summary.mentionCoverage.denominator} non-brand queries and named Coastal Stays`)
    const quality = await read('/api/v1/projects/harbor-resorts/measurement-data-quality')
    expect(status).toContain(`${quality.completeness.answered} of ${quality.completeness.expected} expected answers`)
    const deadLinks = await read('/api/v1/projects/harbor-resorts/technical-aeo/dead-links')
    expect(deadLinks.found).toBeGreaterThan(0)
    expect(status).toContain(`found ${deadLinks.found} dead links`)
    expect(answer('harbor-resorts', 'insights')).toContain(`**${deadLinks.found} dead links from the site audit.**`)

    const changes = answer('harbor-resorts', 'changes')
    const branded = await read('/api/v1/projects/harbor-resorts/measurement-changes?queryClass=branded')
    const metric = branded.comparison.metrics.mentionCoverage
    expect(changes).toContain(`${ratio(metric.current)}, ${metric.current.numerator < metric.previous.numerator ? 'down' : 'up'} from ${ratio(metric.previous)}`)
    expect(changes).toContain(`${branded.comparison.changedProperties.length} properties went from 3 of 3 engines to 2 of 3`)
    const nonBrand = await read('/api/v1/projects/harbor-resorts/measurement-changes?queryClass=non-brand')
    expect(nonBrand.comparison.changedProperties).toEqual([])
    expect(changes).toContain('No property changed.')
  })

  it('answers Harbor insights from measured findings, never the fixed sample rows', async () => {
    const insights = answer('harbor-resorts', 'insights')
    const stored = await read('/api/v1/projects/harbor-resorts/insights') as Json[]
    expect(insights).toContain(`Only ${stored.length} insights are stored for Harbor Resorts`)
    for (const row of stored) expect(insights).not.toContain(row.title)
    const health = await read('/api/v1/projects/harbor-resorts/health/latest')
    expect(insights).not.toContain(String(health.totalPairs))
    expect(JSON.stringify(previews.get('harbor-resorts'))).not.toMatch(/perplexity/i)
  })

  it('refuses unknown projects and keeps the live agent closed', async () => {
    const missing = await inject({ url: '/api/v1/projects/no-such-project/agent/preview' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')
    for (const path of ['transcript', 'providers', 'conversations']) {
      const response = await inject({ url: `/api/v1/projects/summit-roofing/agent/${path}` })
      expect(response.statusCode, path).toBe(403)
    }
    expect((await inject({ url: '/api/v1/projects/summit-roofing/agent/prompt', method: 'POST', payload: { prompt: 'status' } })).statusCode).toBe(403)
    expect(network).not.toHaveBeenCalled()
  })
})
