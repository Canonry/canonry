import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'

const mockGetProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    putProject: mockPutProject,
  }),
}))

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
  providerModels: { openai: 'gpt-5.4' },
  researchProvider: null,
}

const { updateProjectSettings } = await import('../src/commands/project.js')
const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

describe('project researchProvider CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProject.mockResolvedValue(project)
    mockPutProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('sets a configured text route as researchProvider without making it a sweep provider', async () => {
    await updateProjectSettings('acme', { researchProvider: 'route:research-gateway' })

    expect(mockPutProject).toHaveBeenCalledWith('acme', expect.objectContaining({
      providers: ['openai'],
      providerModels: { openai: 'gpt-5.4' },
      researchProvider: 'route:research-gateway',
    }))
  })

  it('clears the persisted researchProvider with an explicit null', async () => {
    mockGetProject.mockResolvedValue({ ...project, researchProvider: 'route:research-gateway' })
    await updateProjectSettings('acme', { researchProvider: null })

    expect(mockPutProject).toHaveBeenCalledWith('acme', expect.objectContaining({ researchProvider: null }))
  })

  it('supports --research-provider and an explicit --clear-research-provider command path', async () => {
    const command = PROJECT_CLI_COMMANDS.find(spec => spec.path.join(' ') === 'project update')!
    await command.run({
      positionals: ['acme'],
      values: { 'research-provider': 'route:research-gateway' },
      format: 'json',
      dryRun: false,
    })
    expect(mockPutProject).toHaveBeenCalledWith('acme', expect.objectContaining({ researchProvider: 'route:research-gateway' }))

    vi.clearAllMocks()
    mockGetProject.mockResolvedValue({ ...project, researchProvider: 'route:research-gateway' })
    mockPutProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
    await command.run({
      positionals: ['acme'],
      values: { 'clear-research-provider': true },
      format: 'json',
      dryRun: false,
    })
    expect(mockPutProject).toHaveBeenCalledWith('acme', expect.objectContaining({ researchProvider: null }))
  })

  it('rejects set and clear together before updating the project', async () => {
    const command = PROJECT_CLI_COMMANDS.find(spec => spec.path.join(' ') === 'project update')!
    await expect(command.run({
      positionals: ['acme'],
      values: { 'research-provider': 'route:research-gateway', 'clear-research-provider': true },
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockPutProject).not.toHaveBeenCalled()
  })
})
