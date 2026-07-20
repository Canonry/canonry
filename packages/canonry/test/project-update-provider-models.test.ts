import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'

const mockGetProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    putProject: mockPutProject,
  }),
}))

const { updateProjectSettings } = await import('../src/commands/project.js')

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
  providers: ['openai', 'gemini'],
  providerModels: { openai: 'gpt-5-nano', gemini: 'gemini-2.5-pro' },
}

/** The single body the command PUT back. */
function putBody(): Record<string, unknown> {
  expect(mockPutProject).toHaveBeenCalledTimes(1)
  return mockPutProject.mock.calls[0]![1] as Record<string, unknown>
}

describe('updateProjectSettings — provider model overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProject.mockResolvedValue(project)
    mockPutProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('drops the override for an engine the update deselects', async () => {
    await updateProjectSettings('acme', { providers: ['gemini'] })
    // openai is no longer a selected engine — its override must not be persisted,
    // or it silently re-applies if openai is added back later.
    expect(putBody()).toMatchObject({
      providers: ['gemini'],
      providerModels: { gemini: 'gemini-2.5-pro' },
    })
    expect(putBody().providerModels).not.toHaveProperty('openai')
  })

  it('cleans up an already-orphaned override on an unrelated update', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: ['gemini'] })
    await updateProjectSettings('acme', { displayName: 'Acme Inc' })
    expect(putBody()).toMatchObject({
      displayName: 'Acme Inc',
      providers: ['gemini'],
      providerModels: { gemini: 'gemini-2.5-pro' },
    })
  })

  it('keeps every override when the project runs all configured engines', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: [] })
    // An empty provider list means "all configured engines" — no override is
    // orphaned, so none may be dropped.
    await updateProjectSettings('acme', { displayName: 'Acme Inc' })
    expect(putBody()).toMatchObject({
      providerModels: { openai: 'gpt-5-nano', gemini: 'gemini-2.5-pro' },
    })
  })

  it('keeps overrides for engines that survive the narrowing, merging new ones', async () => {
    await updateProjectSettings('acme', {
      providers: ['openai', 'gemini'],
      providerModels: { gemini: 'gemini-3-pro' },
    })
    expect(putBody()).toMatchObject({
      providerModels: { openai: 'gpt-5-nano', gemini: 'gemini-3-pro' },
    })
  })

  it('still honours --clear-provider-model for a selected engine', async () => {
    await updateProjectSettings('acme', { clearProviderModels: ['openai'] })
    expect(putBody().providerModels).toEqual({ gemini: 'gemini-2.5-pro' })
  })

  it('rejects an override set for an engine the update does not select', async () => {
    await expect(updateProjectSettings('acme', {
      providers: ['gemini'],
      providerModels: { openai: 'gpt-5-mini' },
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    // Nothing is written when the request contradicts itself.
    expect(mockPutProject).not.toHaveBeenCalled()
  })

  it('rejects an override set for an engine the project already does not run', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: ['gemini'], providerModels: {} })
    await expect(updateProjectSettings('acme', {
      providerModels: { openai: 'gpt-5-mini' },
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockPutProject).not.toHaveBeenCalled()
  })
})
