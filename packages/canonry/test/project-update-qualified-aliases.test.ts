import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'

// `qualifiedAliases` is sentiment-only: the aliases the evaluator is told are
// the brand's own names. The CLI sends it only when a qualified-alias flag is
// given, because the server keeps the stored list when the field is omitted.

const mockGetProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    putProject: mockPutProject,
  }),
}))

const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

const project: ProjectDto = {
  id: 'proj_harborline',
  name: 'harborline',
  displayName: 'Harborline Labs',
  canonicalDomain: 'harborline.example',
  ownedDomains: [],
  aliases: ['HBLNYC', 'HBL NYC', 'Harborline'],
  qualifiedAliases: ['HBLNYC'],
  country: 'US',
  language: 'en',
  configSource: 'api',
  configRevision: 4,
  tags: [],
  labels: {},
  locations: [],
  defaultLocation: null,
  providers: ['openai'],
  providerModels: {},
  providerDispatchModes: {},
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
  autoExtractBacklinks: false,
}

let stdout: string[]

beforeEach(() => {
  vi.clearAllMocks()
  stdout = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => { stdout.push(line) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockGetProject.mockResolvedValue(project)
  mockPutProject.mockImplementation(async (_name: string, body: Record<string, unknown>) => ({
    ...project,
    ...body,
    qualifiedAliases: (body.qualifiedAliases as string[] | undefined) ?? project.qualifiedAliases,
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function run(...args: string[]) {
  return dispatchRegisteredCommand(args, 'human', PROJECT_CLI_COMMANDS)
}

function sentBody(): Record<string, unknown> {
  expect(mockPutProject).toHaveBeenCalledTimes(1)
  return mockPutProject.mock.calls[0]![1] as Record<string, unknown>
}

describe('canonry project update qualified aliases', () => {
  it('--add-qualified-alias sends the stored list plus the new name, deduped case-insensitively', async () => {
    await run('project', 'update', 'harborline', '--add-qualified-alias', 'HBL NYC', '--add-qualified-alias', 'hblnyc')
    expect(sentBody().qualifiedAliases).toEqual(['HBLNYC', 'HBL NYC'])
  })

  it('--remove-qualified-alias sends the stored list without the name', async () => {
    mockGetProject.mockResolvedValue({ ...project, qualifiedAliases: ['HBL NYC', 'HBLNYC'] })
    await run('project', 'update', 'harborline', '--remove-qualified-alias', 'hblnyc')
    expect(sentBody().qualifiedAliases).toEqual(['HBL NYC'])
  })

  it('an unrelated update omits the field so the server keeps the stored list', async () => {
    await run('project', 'update', 'harborline', '--country', 'CA')
    expect(sentBody()).not.toHaveProperty('qualifiedAliases')
  })

  it('--remove-alias alone omits the field; the server drops the qualification itself', async () => {
    await run('project', 'update', 'harborline', '--remove-alias', 'HBLNYC')
    const body = sentBody()
    expect(body.aliases).toEqual(['HBL NYC', 'Harborline'])
    expect(body).not.toHaveProperty('qualifiedAliases')
  })

  it('--remove-alias with a qualified-alias flag drops the removed name instead of echoing it back', async () => {
    await run('project', 'update', 'harborline', '--remove-alias', 'hblnyc', '--add-qualified-alias', 'HBL NYC')
    const body = sentBody()
    expect(body.aliases).toEqual(['HBL NYC', 'Harborline'])
    expect(body.qualifiedAliases).toEqual(['HBL NYC'])
  })

  it('--display-name with a qualified-alias flag drops a stored name the new display name spells', async () => {
    mockGetProject.mockResolvedValue({ ...project, aliases: ['HBLNYC', 'HBL NYC', 'Foo Bar'], qualifiedAliases: ['HBLNYC'] })
    await run('project', 'update', 'harborline', '--display-name', 'HBL NYC', '--add-qualified-alias', 'Foo Bar')
    const body = sentBody()
    expect(body.aliases).toEqual(['HBLNYC', 'Foo Bar'])
    expect(body.qualifiedAliases).toEqual(['Foo Bar'])
  })

  it('reads a project from a server that predates the field as an empty list', async () => {
    const { qualifiedAliases: _omitted, ...legacy } = project
    mockGetProject.mockResolvedValue(legacy)
    await run('project', 'update', 'harborline', '--add-qualified-alias', 'HBL NYC')
    expect(sentBody().qualifiedAliases).toEqual(['HBL NYC'])
  })

  it('--add-alias and --add-qualified-alias in one call send both', async () => {
    await run('project', 'update', 'harborline', '--add-alias', 'HBL Studio', '--add-qualified-alias', 'HBL Studio')
    const body = sentBody()
    expect(body.aliases).toEqual(['HBLNYC', 'HBL NYC', 'Harborline', 'HBL Studio'])
    expect(body.qualifiedAliases).toEqual(['HBLNYC', 'HBL Studio'])
  })

  it('prints the API response as JSON', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'harborline', '--add-qualified-alias', 'HBL NYC', '--format', 'json'], 'json', PROJECT_CLI_COMMANDS)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]!)).toMatchObject({ name: 'harborline', qualifiedAliases: ['HBLNYC', 'HBL NYC'] })
  })
})

describe('canonry project create and show qualified aliases', () => {
  it('create --qualified-alias sends the list; create without it omits the field', async () => {
    await run('project', 'create', 'harborline', '--domain', 'harborline.example', '--display-name', 'Harborline Labs', '--alias', 'HBLNYC', '--qualified-alias', 'HBLNYC')
    expect(sentBody()).toMatchObject({ aliases: ['HBLNYC'], qualifiedAliases: ['HBLNYC'] })

    mockPutProject.mockClear()
    await run('project', 'create', 'plain', '--domain', 'plain.example', '--alias', 'Plain Co')
    expect(sentBody()).not.toHaveProperty('qualifiedAliases')
  })

  it('show prints the qualified line in the label column only when the list is non-empty', async () => {
    await run('project', 'show', 'harborline')
    expect(stdout).toContain('  Qualified:        HBLNYC (sentiment)')
    const aliasesLine = stdout.find(line => line.startsWith('  Aliases:'))!
    expect('  Qualified:        '.length).toBe(aliasesLine.indexOf('HBLNYC'))

    stdout = []
    mockGetProject.mockResolvedValue({ ...project, qualifiedAliases: [] })
    await run('project', 'show', 'harborline')
    expect(stdout.some(line => line.includes('Qualified:'))).toBe(false)

    stdout = []
    const { qualifiedAliases: _omitted, ...legacy } = project
    mockGetProject.mockResolvedValue(legacy)
    await run('project', 'show', 'harborline')
    expect(stdout.some(line => line.includes('Qualified:'))).toBe(false)
  })

  it('show --format json carries the field', async () => {
    await dispatchRegisteredCommand(['project', 'show', 'harborline', '--format', 'json'], 'json', PROJECT_CLI_COMMANDS)
    expect(JSON.parse(stdout.join('\n')).qualifiedAliases).toEqual(['HBLNYC'])
  })
})
