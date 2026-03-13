import { it } from 'node:test'
import assert from 'node:assert/strict'
import { listEvents } from '../src/commands/notify.js'

it('listEvents prints all 4 notification event types', () => {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    listEvents()
  } finally {
    console.log = origLog
  }

  const output = logs.join('\n')
  assert.ok(output.includes('citation.lost'))
  assert.ok(output.includes('citation.gained'))
  assert.ok(output.includes('run.completed'))
  assert.ok(output.includes('run.failed'))
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
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 4)
  assert.ok(parsed.every((e: { event: string; description: string }) => e.event && e.description))
})
