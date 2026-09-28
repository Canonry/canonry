import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockTriggerRun = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    triggerRun: mockTriggerRun,
  }),
}))

const { RUN_CLI_COMMANDS } = await import('../src/cli-commands/run.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { CliError } = await import('../src/cli-error.js')

function runSpec(path: string) {
  const spec = RUN_CLI_COMMANDS.find(candidate => candidate.path.join(' ') === path)
  if (!spec) throw new Error(`no CLI spec for "${path}"`)
  return spec
}

async function dispatch(args: string[]) {
  return dispatchRegisteredCommand(args, 'json', RUN_CLI_COMMANDS)
}

function lastBody(): Record<string, unknown> {
  const call = mockTriggerRun.mock.calls.at(-1)
  if (!call) throw new Error('triggerRun was never called')
  return call[1] as Record<string, unknown>
}

beforeEach(() => {
  mockTriggerRun.mockReset()
  mockTriggerRun.mockResolvedValue({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
})

describe('canonry run trigger', () => {
  it('is a registered command whose usage names the scope flags', () => {
    const spec = runSpec('run trigger')
    expect(spec.usage).toContain('canonry run trigger <project>')
    expect(spec.usage).toContain('--group <key>')
    expect(spec.usage).toContain('--target <key>')
  })

  it('maps --group and --target onto measurementScope', async () => {
    await dispatch(['run', 'trigger', 'planned', '--group', 'metro-group', '--target', 'north-branch', '--target', 'south-branch'])

    expect(mockTriggerRun).toHaveBeenCalledTimes(1)
    expect(mockTriggerRun.mock.calls[0]![0]).toBe('planned')
    expect(lastBody().measurementScope).toEqual({
      groups: ['metro-group'],
      targets: ['north-branch', 'south-branch'],
    })
  })

  it('sends only the half of the scope that was given', async () => {
    await dispatch(['run', 'trigger', 'planned', '--group', 'metro-group'])
    expect(lastBody().measurementScope).toEqual({ groups: ['metro-group'] })

    await dispatch(['run', 'trigger', 'planned', '--target', 'north-branch'])
    expect(lastBody().measurementScope).toEqual({ targets: ['north-branch'] })
  })

  it('sends no scope at all for a full sweep', async () => {
    await dispatch(['run', 'trigger', 'planned'])
    expect(lastBody()).not.toHaveProperty('measurementScope')
  })

  it('dispatches Muse as the selected provider for a probe run', async () => {
    await dispatch(['run', 'trigger', 'planned', '--provider', 'muse', '--probe'])
    expect(mockTriggerRun).toHaveBeenCalledTimes(1)
    expect(mockTriggerRun.mock.calls[0]![0]).toBe('planned')
    expect(lastBody()).toMatchObject({ providers: ['muse'], trigger: 'probe' })
  })

  it('accepts the same scope flags on the bare `canonry run` form', async () => {
    await dispatch(['run', 'planned', '--group', 'metro-group'])
    expect(lastBody().measurementScope).toEqual({ groups: ['metro-group'] })
  })

  it('requires a project name', async () => {
    await expect(dispatch(['run'])).rejects.toThrow(CliError)
    expect(mockTriggerRun).not.toHaveBeenCalled()
  })

  it('runs a project that is actually named "trigger"', async () => {
    // `canonry run trigger` is ambiguous: it reads as the subcommand with no
    // project, and as the old form naming a project called "trigger". Nobody
    // types the subcommand without a project, so the project wins.
    await dispatch(['run', 'trigger'])

    expect(mockTriggerRun).toHaveBeenCalledTimes(1)
    expect(mockTriggerRun.mock.calls[0]![0]).toBe('trigger')
  })

  it('still treats a following name as the project, not as two projects', async () => {
    await dispatch(['run', 'trigger', 'trigger'])
    expect(mockTriggerRun.mock.calls[0]![0]).toBe('trigger')

    await dispatch(['run', 'trigger', 'planned', '--group', 'metro-group'])
    expect(mockTriggerRun.mock.calls[1]![0]).toBe('planned')
    expect(lastBody().measurementScope).toEqual({ groups: ['metro-group'] })
  })

  it('rejects a scope combined with --all, which has no single project to scope against', async () => {
    await expect(dispatch(['run', 'trigger', '--all', '--group', 'metro-group'])).rejects.toThrow(/--group/)
    expect(mockTriggerRun).not.toHaveBeenCalled()
  })

  it('rejects a scope combined with --query, which is a different way to pick a subset', async () => {
    await expect(dispatch(['run', 'trigger', 'planned', '--query', 'widget pricing', '--target', 'north-branch']))
      .rejects.toThrow(/--query/)
    expect(mockTriggerRun).not.toHaveBeenCalled()
  })

  it('rejects an unknown flag', async () => {
    await expect(dispatch(['run', 'trigger', 'planned', '--segment', 'metro-group'])).rejects.toThrow(CliError)
    expect(mockTriggerRun).not.toHaveBeenCalled()
  })
})
