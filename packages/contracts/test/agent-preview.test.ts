import { expect, it } from 'vitest'
import { aeroPreviewResponseSchema, aeroPreviewStarterIds } from '../src/agent.js'

const step = { text: 'Reading the report.', tool: { name: 'canonry_visibility_report', label: 'Read scoped AI visibility', arguments: { project: 'demo' }, result: { ok: true }, durationMs: 640 } }

it('accepts the scripted preview shape for the four dashboard starters', () => {
  expect(aeroPreviewStarterIds).toEqual(['status', 'changes', 'gaps', 'insights'])
  const parsed = aeroPreviewResponseSchema.parse({
    project: 'demo',
    seededAt: '2026-09-23T12:00:00.000Z',
    starters: aeroPreviewStarterIds.map(id => ({ id, steps: [step, { tool: step.tool }], answer: 'Done.' })),
  })
  expect(parsed.starters[0]!.steps[1]!.text).toBeUndefined()
})

it('rejects unknown starters and malformed tool steps', () => {
  const base = { project: 'demo', seededAt: '2026-09-23T12:00:00.000Z' }
  expect(aeroPreviewResponseSchema.safeParse({ ...base, starters: [{ id: 'last-run', steps: [], answer: '' }] }).success).toBe(false)
  for (const durationMs of [-1, 1.5]) {
    expect(aeroPreviewResponseSchema.safeParse({ ...base, starters: [{ id: 'status', steps: [{ tool: { ...step.tool, durationMs } }], answer: '' }] }).success).toBe(false)
  }
  expect(aeroPreviewResponseSchema.safeParse({ ...base, starters: [{ id: 'status', steps: [{ tool: { ...step.tool, arguments: 'project=demo' } }], answer: '' }] }).success).toBe(false)
})
