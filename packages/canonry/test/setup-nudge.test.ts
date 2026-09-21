import { describe, expect, it } from 'vitest'
import { buildSetupNudgeLine } from '../src/setup-nudge.js'
import type { SetupState } from '../src/setup-state.js'

const unconfigured: SetupState = {
  provider_count: 0,
  has_keywords: false,
  project_count: 1,
  is_first_run: false,
}

const base = {
  command: 'run',
  machineFormat: false,
  stderrIsTTY: true,
  getSetupState: () => unconfigured as SetupState | undefined,
}

describe('the stalled-setup nudge', () => {
  it('shows for a human-mode visibility command on a provider-less install', () => {
    const line = buildSetupNudgeLine(base)
    expect(line).toContain('AI Visibility needs an answer-engine provider')
    expect(line).toContain('Page Health does not')
    expect(line).toContain('canonry serve')
    expect(line).toContain('canonry settings provider')
    expect(line).not.toContain('Finish setup')
    expect(line).not.toContain('answer sweeps cannot run')
  })

  it('never pollutes machine formats', () => {
    // The whole reason it goes to stderr under a TTY gate: `--format json`
    // consumers must get exactly the JSON document and nothing else.
    expect(buildSetupNudgeLine({ ...base, machineFormat: true })).toBeNull()
  })

  it('never interleaves into captured output', () => {
    expect(buildSetupNudgeLine({ ...base, stderrIsTTY: false })).toBeNull()
  })

  it('stays quiet once any provider exists', () => {
    expect(
      buildSetupNudgeLine({
        ...base,
        getSetupState: () => ({ ...unconfigured, provider_count: 1 }),
      }),
    ).toBeNull()
  })

  it('stays quiet pre-init, where init itself is the guidance', () => {
    expect(buildSetupNudgeLine({ ...base, getSetupState: () => undefined })).toBeNull()
  })

  it.each([
    'init',
    'serve',
    'start',
    'stop',
    'bootstrap',
    'telemetry',
    'project',
    'technical-aeo',
    'site-health',
    'doctor',
    'demo',
    'status',
    'unknown',
  ])(
    'stays quiet on %s, which is or manages the Page Health path',
    command => {
      expect(buildSetupNudgeLine({ ...base, command })).toBeNull()
    },
  )

  it('exempts nested Page Health commands via the command root', () => {
    expect(buildSetupNudgeLine({ ...base, command: 'technical-aeo.run' })).toBeNull()
    expect(buildSetupNudgeLine({ ...base, command: 'site-health.pages' })).toBeNull()
    expect(buildSetupNudgeLine({ ...base, command: 'project.create' })).toBeNull()
  })

  it('exempts every settings subcommand via the command root', () => {
    // `settings.provider` is how the user FIXES the missing provider; nudging
    // them mid-fix would be nagging.
    expect(buildSetupNudgeLine({ ...base, command: 'settings.provider' })).toBeNull()
  })

  it('nudges on nested non-exempt commands', () => {
    expect(buildSetupNudgeLine({ ...base, command: 'google.status' })).not.toBeNull()
  })

  it('never reads state when a cheap gate already declines', () => {
    // The read opens config and the database; control commands and
    // non-interactive runs are pinned by the CLI telemetry tests as doing
    // neither. The gates make that guarantee here, once, for every caller.
    const read = () => {
      throw new Error('setup state must not be read')
    }
    expect(buildSetupNudgeLine({ ...base, command: 'telemetry', getSetupState: read })).toBeNull()
    expect(buildSetupNudgeLine({ ...base, machineFormat: true, getSetupState: read })).toBeNull()
    expect(buildSetupNudgeLine({ ...base, stderrIsTTY: false, getSetupState: read })).toBeNull()
  })
})
