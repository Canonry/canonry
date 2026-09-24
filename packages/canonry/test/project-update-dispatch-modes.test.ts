import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'

// The server keeps a dispatch preference only for an engine the project's runs
// measure. When it drops one, `canonry project update` must not report a plain
// success: the operator (or agent) asked for batch and will not get it. The
// warning goes to stderr in both formats, so `--format json` stdout stays the
// API response byte for byte.

const mockGetProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    putProject: mockPutProject,
  }),
}))

const { createProject, updateProjectSettings } = await import('../src/commands/project.js')

const project: ProjectDto = {
  id: 'proj_acme',
  name: 'acme',
  displayName: 'Acme',
  canonicalDomain: 'acme.com',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  configSource: 'api',
  configRevision: 1,
  tags: [],
  labels: {},
  locations: [],
  defaultLocation: null,
  providers: ['openai'],
  providerModels: {},
  providerDispatchModes: {},
}

let stdout: string[]
let stderr: string[]

beforeEach(() => {
  vi.clearAllMocks()
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => { stdout.push(line) })
  vi.spyOn(console, 'error').mockImplementation((line: string) => { stderr.push(line) })
  mockGetProject.mockResolvedValue(project)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const WARNING = 'Warning: Dropped dispatch mode for engine(s) the project does not measure: claude'

describe('canonry project update — dispatch modes the server did not store', () => {
  it('warns on stderr when a --dispatch-mode it was sent is pruned', async () => {
    // The server pruned claude: the project runs only openai.
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: {} })

    await updateProjectSettings('acme', { dispatchModes: { claude: 'batch' } })

    expect(mockPutProject.mock.calls[0]![1]).toMatchObject({ providerDispatchModes: { claude: 'batch' } })
    expect(stderr).toEqual([WARNING])
    expect(stdout).toEqual(['Project updated: acme'])
  })

  it('warns on stderr in JSON mode and leaves stdout the API response', async () => {
    const result = { ...project, providerDispatchModes: {} }
    mockPutProject.mockResolvedValue(result)

    await updateProjectSettings('acme', { dispatchModes: { claude: 'batch' }, format: 'json' })

    expect(stderr).toEqual([WARNING])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]!)).toEqual(result)
  })

  it('warns when narrowing the engine set drops a stored preference', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: ['openai', 'claude'], providerDispatchModes: { claude: 'batch', openai: 'batch' } })
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: { openai: 'batch' } })

    await updateProjectSettings('acme', { providers: ['openai'] })

    // No dispatch flag: the stored map is left to the server, not sent.
    expect(mockPutProject.mock.calls[0]![1]).not.toHaveProperty('providerDispatchModes')
    expect(stderr).toEqual([WARNING])
  })

  it('says nothing when the server kept the preference (an Advanced revision still measures the engine)', async () => {
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: { claude: 'batch' } })

    await updateProjectSettings('acme', { dispatchModes: { claude: 'batch' } })

    expect(stderr).toEqual([])
    expect(stdout).toEqual(['Project updated: acme'])
  })

  it('says nothing for a preference the operator cleared', async () => {
    mockGetProject.mockResolvedValue({ ...project, providerDispatchModes: { claude: 'batch' } })
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: {} })

    await updateProjectSettings('acme', { clearDispatchModes: ['claude'] })

    expect(mockPutProject.mock.calls[0]![1]).toMatchObject({ providerDispatchModes: {} })
    expect(stderr).toEqual([])
  })
})

describe('canonry project create — dispatch modes the server did not store', () => {
  const create = { domain: 'acme.com', country: 'US', language: 'en', displayName: 'Acme', providers: ['openai'] }

  it('warns on stderr when a --dispatch-mode for an engine outside --provider is pruned', async () => {
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: {} })

    await createProject('acme', { ...create, providerDispatchModes: { claude: 'batch' } })

    expect(stderr).toEqual([WARNING])
    expect(stdout).toEqual(['Project created: acme (proj_acme)'])
  })

  it('says nothing when every preference was stored', async () => {
    mockPutProject.mockResolvedValue({ ...project, providerDispatchModes: { openai: 'batch' } })

    await createProject('acme', { ...create, providerDispatchModes: { openai: 'batch' } })

    expect(stderr).toEqual([])
  })
})
