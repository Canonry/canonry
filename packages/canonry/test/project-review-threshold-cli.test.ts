import { describe, expect, it, vi, beforeEach } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'

const updateProjectSettings = vi.fn()

vi.mock('../src/commands/project.js', () => ({
  addLocation: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listLocations: vi.fn(),
  listProjects: vi.fn(),
  removeLocation: vi.fn(),
  setDefaultLocation: vi.fn(),
  showProject: vi.fn(),
  updateProjectSettings,
}))

const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

function thresholdSent(): unknown {
  expect(updateProjectSettings).toHaveBeenCalledTimes(1)
  return (updateProjectSettings.mock.calls[0]![1] as { negativeReviewMaxStars?: unknown }).negativeReviewMaxStars
}

describe('project update --negative-review-max-stars', () => {
  beforeEach(() => updateProjectSettings.mockReset())

  it('sets a threshold from 1 to 4', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--negative-review-max-stars', '2'], 'human', PROJECT_CLI_COMMANDS)
    expect(thresholdSent()).toBe(2)
  })

  it('resets to the default with "default"', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--negative-review-max-stars', 'default'], 'human', PROJECT_CLI_COMMANDS)
    expect(thresholdSent()).toBeNull()
  })

  it('leaves the threshold alone when the flag is absent', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--country', 'US'], 'human', PROJECT_CLI_COMMANDS)
    expect(thresholdSent()).toBeUndefined()
  })

  it('rejects values outside 1-4 before any request', async () => {
    for (const value of ['0', '5', '2.5', 'three']) {
      await expect(dispatchRegisteredCommand(
        ['project', 'update', 'acme', '--negative-review-max-stars', value], 'human', PROJECT_CLI_COMMANDS,
      )).rejects.toThrow('--negative-review-max-stars must be 1-4 or "default"')
    }
    expect(updateProjectSettings).not.toHaveBeenCalled()
  })
})
