import { describe, expect, it } from 'vitest'
import { AGENT_CHECKS } from '../src/doctor/checks/agent.js'
import type { BundledSkillSnapshot } from '@canonry/canonry-contracts'

/**
 * Every other agent.skills.* check measures DISTRIBUTION: is the skill present,
 * is it current. None measured the trigger surface, which is what decides
 * whether the skill is ever loaded. A skill is model-decided, so its
 * description is the entire surface a request gets matched against.
 */
const check = AGENT_CHECKS.find((c) => c.id === 'agent.skills.trigger-surface')!

function snapshot(name: string, description?: string): BundledSkillSnapshot {
  return { name, version: '1.0.0', files: {}, ...(description === undefined ? {} : { description }) }
}

const GOOD = 'Operate Canonry (the `cnry` / `canonry` CLI) for AEO. Load this before any operator task: '
  + 'creating a project, connecting an integration, running a sweep, or diagnosing why a number moved.'

function run(bundledSkills?: BundledSkillSnapshot[]) {
  return check.run({ bundledSkills } as never) as { status: string; code: string; details: Record<string, unknown> }
}

describe('agent.skills.trigger-surface', () => {
  it('skips where no skills are bundled, rather than inventing a failure', () => {
    expect(run(undefined).status).toBe('skipped')
    expect(run([]).status).toBe('skipped')
  })

  it('passes a description that is substantial and names the CLI', () => {
    const result = run([snapshot('canonry', GOOD)])
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.trigger-surface-ok')
  })

  it('does not claim the skill will load, only that the surface looks right', () => {
    const result = run([snapshot('canonry', GOOD)]) as unknown as { summary: string }
    expect(result.summary).toMatch(/not whether an agent actually loads it/i)
  })

  it('fails when a description is absent, since the skill can never be selected', () => {
    const result = run([snapshot('canonry')])
    expect(result.status).toBe('fail')
    expect(result.code).toBe('agent.skills.description-missing')
  })

  it('fails over the 1024-char cap', () => {
    const result = run([snapshot('canonry', 'cnry ' + 'x'.repeat(1100))])
    expect(result.status).toBe('fail')
    expect(result.code).toBe('agent.skills.description-too-long')
  })

  it('warns when the description never names the CLI the operator types', () => {
    const noCli = 'Answer Engine Optimization analysis and orchestration across providers, with durable '
      + 'project memory and proactive regression response for client reporting workflows.'
    const result = run([snapshot('aero', noCli)])
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.description-weak')
  })

  it('warns on a description too thin to match against', () => {
    const result = run([snapshot('canonry', 'cnry stuff')])
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.description-weak')
  })

  it('reports total listing cost, the number that competes for session budget', () => {
    const result = run([snapshot('canonry', GOOD), snapshot('aero', GOOD)])
    expect(result.details.totalDescriptionLength).toBe(GOOD.length * 2)
  })
})
