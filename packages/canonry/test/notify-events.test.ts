import { it, expect } from 'vitest'
import { listEvents } from '../src/commands/notify.js'

it('listEvents prints all 7 notification event types', () => {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    listEvents()
  } finally {
    console.log = origLog
  }

  const output = logs.join('\n')
  expect(output.includes('citation.lost')).toBeTruthy()
  expect(output.includes('citation.gained')).toBeTruthy()
  expect(output.includes('run.completed')).toBeTruthy()
  expect(output.includes('run.failed')).toBeTruthy()
  expect(output.includes('social.mention.new')).toBeTruthy()
  expect(output.includes('social.sentiment.negative')).toBeTruthy()
  expect(output.includes('social.spike')).toBeTruthy()
})

it('listEvents outputs valid JSON with --format json', () => {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    listEvents('json')
  } finally {
    console.log = origLog
  }

  const parsed = JSON.parse(logs.join('\n'))
  expect(Array.isArray(parsed)).toBeTruthy()
  expect(parsed.length).toBe(7)
  expect(parsed.every((e: { event: string; description: string }) => e.event && e.description)).toBeTruthy()
})
