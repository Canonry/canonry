import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError } from '../src/cli-error.js'

const mockGetProject = vi.fn()
const mockPatchProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    patchProject: mockPatchProject,
    putProject: mockPutProject,
  }),
}))

const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

const project: ProjectDto = {
  id: 'project_measurement',
  name: 'measurement-project',
  displayName: 'Measurement Project',
  canonicalDomain: 'measurement.example',
  ownedDomains: ['www.measurement.example'],
  aliases: ['Measurement Project'],
  qualifiedAliases: [],
  country: 'US',
  language: 'en',
  tags: ['simple'],
  labels: { team: 'test' },
  providers: ['openai'],
  providerModels: {},
  providerDispatchModes: {},
  measurement: {
    marketingHosts: ['offers.measurement.example'],
    brandTerms: ['Measurement Project'],
    leadEventNames: ['generate_lead'],
  },
  locations: [],
  defaultLocation: null,
  autoExtractBacklinks: false,
  negativeReviewMaxStars: 3,
  siteAuditMaxPages: null,
  competitorAutoAliases: 'preview',
  configSource: 'api',
  configRevision: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

let output: string[]

beforeEach(() => {
  vi.clearAllMocks()
  output = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockGetProject.mockResolvedValue(project)
  mockPatchProject.mockImplementation(async (_name: string, body: Record<string, unknown>) => ({ ...project, ...body }))
  mockPutProject.mockImplementation(async (_name: string, body: Record<string, unknown>) => ({ ...project, ...body }))
})

afterEach(() => vi.restoreAllMocks())

function run(...args: string[]) {
  return dispatchRegisteredCommand(args, 'human', PROJECT_CLI_COMMANDS)
}

function body(): Record<string, unknown> {
  expect(mockPatchProject).toHaveBeenCalledTimes(1)
  return mockPatchProject.mock.calls[0]![1] as Record<string, unknown>
}

describe('project measurement update flags', () => {
  it('merges measurement flags and returns the updated ProjectDto', async () => {
    await run(
      'project', 'update', 'measurement-project',
      '--add-lead-event', 'book_demo',
      '--add-brand-term', 'Measurement Pro',
      '--add-marketing-host', 'checkout.measurement.example',
      '--format', 'json',
    )

    expect(body().measurement).toEqual({
      marketingHosts: ['offers.measurement.example', 'checkout.measurement.example'],
      brandTerms: ['Measurement Project', 'Measurement Pro'],
      leadEventNames: ['generate_lead', 'book_demo'],
    })
    expect(JSON.parse(output.join('\n'))).toMatchObject({
      measurement: {
        marketingHosts: ['offers.measurement.example', 'checkout.measurement.example'],
        brandTerms: ['Measurement Project', 'Measurement Pro'],
        leadEventNames: ['generate_lead', 'book_demo'],
      },
    })
  })

  it('rejects an invalid event before making a write request', async () => {
    await expect(run('project', 'update', 'measurement-project', '--lead-event', 'bad name!')).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockPatchProject).not.toHaveBeenCalled()
  })

  it('does not send measurement when no measurement flag was supplied', async () => {
    await run('project', 'update', 'measurement-project', '--display-name', 'Renamed', '--format', 'json')
    expect(body()).not.toHaveProperty('measurement')
  })

  it('passes an explicit revision guard through the PATCH request', async () => {
    await run('project', 'update', 'measurement-project', '--display-name', 'Renamed', '--expect-revision', '12', '--format', 'json')
    expect(body().expectedConfigRevision).toBe(12)
  })

  it('uses the full PUT path only when a prior GET is followed by a 404 PATCH', async () => {
    mockPatchProject.mockRejectedValue(new CliError({ code: 'NOT_FOUND', message: 'PATCH route missing', details: { httpStatus: 404 } }))
    await run('project', 'update', 'measurement-project', '--add-lead-event', 'book_demo')
    expect(mockPutProject).toHaveBeenCalledTimes(1)
    expect(mockPutProject.mock.calls[0]![1]).toMatchObject({
      displayName: project.displayName,
      canonicalDomain: project.canonicalDomain,
      measurement: {
        marketingHosts: ['offers.measurement.example'],
        brandTerms: ['Measurement Project'],
        leadEventNames: ['generate_lead', 'book_demo'],
      },
    })
  })

  it('prints measurement lists in human project output', async () => {
    await run('project', 'show', 'measurement-project')
    const text = output.join('\n')
    expect(text).toContain('Marketing hosts:  offers.measurement.example')
    expect(text).toContain('Brand terms:      Measurement Project')
    expect(text).toContain('Lead events:      generate_lead')
  })
})
