import { describe, expect, it } from 'vitest'
import { canGenerateText, isEligibleFor, makesInstallMeasurable, providerWorkflowSchema } from '../src/provider-eligibility.js'

const WORKFLOWS = providerWorkflowSchema.options

describe('workflow eligibility', () => {
  it('admits answer engines everywhere, implicitly and explicitly, exactly as before', () => {
    for (const workflow of WORKFLOWS) {
      expect(isEligibleFor({}, workflow, 'implicit')).toBe(true)
      expect(isEligibleFor({}, workflow, 'explicit')).toBe(true)
    }
  })

  it('never admits an answer service implicitly, and explicitly only for declared workflows', () => {
    const profile = { kind: 'answer-service' as const, capabilities: { textGeneration: false, groundedAnswer: true, workflows: ['research' as const] } }
    for (const workflow of WORKFLOWS) expect(isEligibleFor(profile, workflow, 'implicit')).toBe(false)
    expect(WORKFLOWS.filter(workflow => isEligibleFor(profile, workflow, 'explicit'))).toEqual(['research'])
    // A service connection that declares no workflows runs nothing.
    expect(isEligibleFor({ kind: 'answer-service' }, 'research', 'explicit')).toBe(false)
  })

  it('keeps a saved gateway route eligible wherever it was before', () => {
    for (const workflow of WORKFLOWS) expect(isEligibleFor({ kind: 'model-gateway' }, workflow, 'explicit')).toBe(true)
    expect(isEligibleFor({ kind: 'model-gateway' }, 'research', 'implicit')).toBe(true)
  })

  it('requires both a generateText method and the textGeneration capability for generation roles', () => {
    const generate = async () => 'text'
    expect(canGenerateText({ generateText: generate })).toBe(true)
    expect(canGenerateText({})).toBe(false)
    expect(canGenerateText({ generateText: generate, capabilities: { textGeneration: false, groundedAnswer: true } })).toBe(false)
  })
})

describe('install readiness', () => {
  it('counts answer engines and gateways, never a hosted answer service', () => {
    expect(makesInstallMeasurable({})).toBe(true)
    expect(makesInstallMeasurable({ kind: 'answer-engine' })).toBe(true)
    expect(makesInstallMeasurable({ kind: 'model-gateway' })).toBe(true)
    expect(makesInstallMeasurable({ kind: 'answer-service' })).toBe(false)
  })
})
