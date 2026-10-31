import { describe, expect, it } from 'vitest'
import { NO_PROVIDER_NOTICE_CODE, buildSetupNudgeLine } from '../src/setup-nudge.js'
import type { SetupState } from '../src/setup-state.js'

const unconfigured: SetupState = {
  provider_count: 0,
  has_keywords: false,
  project_count: 1,
  is_first_run: false,
}

const base = {
  command: 'run',
  format: 'text' as const,
  stderrIsTTY: true,
  getSetupState: () => unconfigured as SetupState | undefined,
}

describe('the stalled-setup nudge', () => {
  it('shows for a human-mode visibility command on a provider-less install', async () => {
    const line = await buildSetupNudgeLine(base)
    expect(line).toContain('AI Visibility needs an answer-engine provider')
    expect(line).toContain('Page Health does not')
    expect(line).toContain('canonry serve')
    expect(line).toContain('canonry settings provider')
    // `settings provider` goes through the API, so it fails without a server.
    expect(line).toContain('while the server is running')
    expect(line).toContain('aistudio.google.com')
    expect(line).not.toContain('Finish setup')
    expect(line).not.toContain('answer sweeps cannot run')
  })

  it('never pollutes machine formats', async () => {
    // The whole reason it goes to stderr under a TTY gate: `--format json`
    // consumers must get exactly the JSON document and nothing else.
    expect(await buildSetupNudgeLine({ ...base, format: 'json' })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, format: 'jsonl' })).toBeNull()
  })

  it('never interleaves into captured output', async () => {
    expect(await buildSetupNudgeLine({ ...base, stderrIsTTY: false })).toBeNull()
  })

  it('stays quiet once any provider exists', async () => {
    expect(
      await buildSetupNudgeLine({
        ...base,
        getSetupState: () => ({ ...unconfigured, provider_count: 1 }),
      }),
    ).toBeNull()
  })

  it('stays quiet pre-init, where init itself is the guidance', async () => {
    expect(await buildSetupNudgeLine({ ...base, getSetupState: () => undefined })).toBeNull()
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
    async command => {
      expect(await buildSetupNudgeLine({ ...base, command })).toBeNull()
    },
  )

  it('exempts nested Page Health commands via the command root', async () => {
    expect(await buildSetupNudgeLine({ ...base, command: 'technical-aeo.pages' })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, command: 'site-health.pages' })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, command: 'project.create' })).toBeNull()
  })

  it('exempts every settings subcommand via the command root', async () => {
    // `settings.provider` is how the user FIXES the missing provider; nudging
    // them mid-fix would be nagging.
    expect(await buildSetupNudgeLine({ ...base, command: 'settings.provider' })).toBeNull()
  })

  it('nudges on nested non-exempt commands', async () => {
    expect(await buildSetupNudgeLine({ ...base, command: 'google.status' })).not.toBeNull()
  })

  it('never reads state when a cheap gate already declines', async () => {
    // The read opens config and the database; control commands and
    // non-interactive runs are pinned by the CLI telemetry tests as doing
    // neither. The gates make that guarantee here, once, for every caller.
    const read = () => {
      throw new Error('setup state must not be read')
    }
    expect(await buildSetupNudgeLine({ ...base, command: 'telemetry', getSetupState: read })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, format: 'json', getSetupState: read })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, stderrIsTTY: false, getSetupState: read })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, command: 'technical-aeo.progress', format: 'json', getSetupState: read })).toBeNull()
  })
})

describe('the Page Health handoff to AI Visibility', () => {
  // Most provider-less installs never open the dashboard, and the agents that
  // drive them read JSON or captured stderr. The handoff reaches them there.
  const handoff = { ...base, command: 'technical-aeo.score' }

  it.each(['technical-aeo.run', 'technical-aeo.score', 'technical-aeo.crawl', 'site-health.overview'])(
    'shows on %s on a terminal, despite the Page Health root exemption',
    async command => {
      expect(await buildSetupNudgeLine({ ...handoff, command })).toContain('AI Visibility needs an answer-engine provider')
    },
  )

  it('emits one compact JSON notice line for machine formats', async () => {
    for (const format of ['json', 'jsonl'] as const) {
      const line = await buildSetupNudgeLine({ ...handoff, format, stderrIsTTY: false })
      expect(line).not.toBeNull()
      expect(line!.endsWith('\n')).toBe(true)
      expect(line!.trim().split('\n')).toHaveLength(1)
      const parsed = JSON.parse(line!) as { notice: Record<string, string> }
      expect(parsed.notice.code).toBe(NO_PROVIDER_NOTICE_CODE)
      expect(parsed.notice.setupCommand).toBe('canonry settings provider gemini --api-key <key>')
      expect(parsed.notice.keyUrl).toBe('https://aistudio.google.com/apikey')
      expect(parsed.notice.note).toContain('Never ask for it in chat')
    }
  })

  it('emits one plain line when stderr is captured', async () => {
    const line = await buildSetupNudgeLine({ ...handoff, stderrIsTTY: false })
    expect(line).toMatch(/^\[canonry\] NO_PROVIDER: /)
    expect(line!.trim().split('\n')).toHaveLength(1)
    expect(line).toContain('canonry settings provider gemini --api-key <key>')
    expect(line).toContain('Never ask for the key in chat')
  })

  it('stays quiet once any provider exists, in every mode', async () => {
    const configured = () => ({ ...unconfigured, provider_count: 1 })
    expect(await buildSetupNudgeLine({ ...handoff, getSetupState: configured })).toBeNull()
    expect(await buildSetupNudgeLine({ ...handoff, format: 'json', getSetupState: configured })).toBeNull()
    expect(await buildSetupNudgeLine({ ...handoff, stderrIsTTY: false, getSetupState: configured })).toBeNull()
  })

  it('stays quiet for a CLI pointed at a remote server, whose providers it cannot see', async () => {
    // No local projects while a project command succeeded: the server is elsewhere.
    const remote = () => ({ ...unconfigured, project_count: 0 })
    expect(await buildSetupNudgeLine({ ...handoff, getSetupState: remote })).toBeNull()
    expect(await buildSetupNudgeLine({ ...handoff, format: 'json', stderrIsTTY: false, getSetupState: remote })).toBeNull()
    expect(await buildSetupNudgeLine({ ...base, getSetupState: remote })).toBeNull()
  })

  it('stays quiet pre-init in every mode', async () => {
    expect(await buildSetupNudgeLine({ ...handoff, format: 'json', getSetupState: () => undefined })).toBeNull()
  })

  it('leaves the rest of the Page Health path quiet in machine formats', async () => {
    // `progress` is polled until a scan finishes; one line per poll is noise.
    for (const command of ['technical-aeo.progress', 'technical-aeo.pages', 'site-health.pages', 'bootstrap']) {
      expect(await buildSetupNudgeLine({ ...handoff, command, format: 'json' })).toBeNull()
    }
  })
})
