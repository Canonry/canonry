import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ProjectDto } from '@canonry/canonry-contracts'

const mockGetProject = vi.fn()
const mockPatchProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    patchProject: mockPatchProject,
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

/** The single partial body the command PATCHes. */
function patchBody(): Record<string, unknown> {
  expect(mockPatchProject).toHaveBeenCalledTimes(1)
  return mockPatchProject.mock.calls[0]![1] as Record<string, unknown>
}

describe('updateProjectSettings — provider model overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProject.mockResolvedValue(project)
    mockPatchProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('narrows the engine set without stripping the map client-side', async () => {
    // The API owns the prune (one implementation, one semantics). The CLI
    // omits an untouched map; sending a pruned copy would put the same rule
    // in two places, and the old client-side strip is what turned an ordinary
    // narrowing into an unexplained settings.write 403.
    mockPatchProject.mockResolvedValue({ ...project, providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } })
    await updateProjectSettings('acme', { providers: ['gemini'] })
    expect(patchBody()).toEqual({ expectedConfigRevision: 1, providers: ['gemini'] })
  })

  it('reports the overrides the server dropped', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logged.push(line) })
    mockPatchProject.mockResolvedValue({ ...project, providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } })
    await updateProjectSettings('acme', { providers: ['gemini'] })
    expect(logged.join('\n')).toContain('Dropped model override for deselected engine(s): openai')
  })

  it('says nothing when every override survived', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logged.push(line) })
    await updateProjectSettings('acme', { displayName: 'Acme Inc' })
    expect(logged.join('\n')).not.toContain('Dropped model override')
  })

  it('passes an already-orphaned override through on an unrelated update', async () => {
    // A row written before the rule existed can carry an override for an engine
    // it does not run. The CLI must not reject or silently rewrite it — the
    // update goes through and the server normalizes.
    mockGetProject.mockResolvedValue({ ...project, providers: ['gemini'] })
    mockPatchProject.mockResolvedValue({ ...project, providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } })
    await updateProjectSettings('acme', { displayName: 'Acme Inc' })
    expect(patchBody()).toEqual({ expectedConfigRevision: 1, displayName: 'Acme Inc' })
  })

  it('keeps every override when the project runs all configured engines', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: [] })
    // An empty provider list means "all configured engines" — no override is
    // orphaned, so none may be dropped.
    await updateProjectSettings('acme', { displayName: 'Acme Inc' })
    expect(patchBody()).toEqual({ expectedConfigRevision: 1, displayName: 'Acme Inc' })
  })

  it('keeps overrides for engines that survive the narrowing, merging new ones', async () => {
    await updateProjectSettings('acme', {
      providers: ['openai', 'gemini'],
      providerModels: { gemini: 'gemini-3-pro' },
    })
    expect(patchBody()).toEqual({ expectedConfigRevision: 1, providers: ['openai', 'gemini'], providerModels: { openai: 'gpt-5-nano', gemini: 'gemini-3-pro' } })
  })

  it('still honours --clear-provider-model for a selected engine', async () => {
    await updateProjectSettings('acme', { clearProviderModels: ['openai'] })
    expect(patchBody().providerModels).toEqual({ gemini: 'gemini-2.5-pro' })
  })

  it('rejects an override set for an engine the update does not select', async () => {
    await expect(updateProjectSettings('acme', {
      providers: ['gemini'],
      providerModels: { openai: 'gpt-5-mini' },
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    // Nothing is written when the request contradicts itself.
    expect(mockPatchProject).not.toHaveBeenCalled()
  })

  it('rejects an override set for an engine the project already does not run', async () => {
    mockGetProject.mockResolvedValue({ ...project, providers: ['gemini'], providerModels: {} })
    await expect(updateProjectSettings('acme', {
      providerModels: { openai: 'gpt-5-mini' },
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockPatchProject).not.toHaveBeenCalled()
  })
})

describe('updateProjectSettings — negative review threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProject.mockResolvedValue({ ...project, negativeReviewMaxStars: 2 })
    mockPatchProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('sends a new threshold, and null to reset it', async () => {
    await updateProjectSettings('acme', { negativeReviewMaxStars: 4 })
    expect(patchBody().negativeReviewMaxStars).toBe(4)
    mockPatchProject.mockClear()
    await updateProjectSettings('acme', { negativeReviewMaxStars: null })
    expect(patchBody().negativeReviewMaxStars).toBeNull()
  })

  it('omits the field otherwise, so the server keeps the stored threshold', async () => {
    await updateProjectSettings('acme', { country: 'US' })
    expect(patchBody()).not.toHaveProperty('negativeReviewMaxStars')
  })
})
