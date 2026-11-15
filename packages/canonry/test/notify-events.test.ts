import { NOTIFICATION_EVENT_DESCRIPTIONS, notificationEventSchema } from '@canonry/canonry-contracts'
import { it, expect } from 'vitest'
import { listEvents } from '../src/commands/notify.js'

function captureLog(run: () => void): string[] {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    run()
  } finally {
    console.log = origLog
  }
  return logs
}

it('listEvents prints every notification event on its own line with its description', () => {
  const lines = captureLog(() => listEvents())
  for (const event of notificationEventSchema.options) {
    const line = lines.find(candidate => candidate.trimStart().startsWith(`${event} `))
    expect(line, event).toBeDefined()
    expect(line!.endsWith(NOTIFICATION_EVENT_DESCRIPTIONS[event]), event).toBe(true)
  }
  // Both AI visibility signals are subscribable, each in both directions.
  for (const event of ['citation.lost', 'citation.gained', 'mention.lost', 'mention.gained']) {
    expect(lines.some(line => line.trimStart().startsWith(`${event} `)), event).toBe(true)
  }
})

it('listEvents outputs valid JSON with --format json', () => {
  const parsed = JSON.parse(captureLog(() => listEvents('json')).join('\n'))
  expect(parsed).toEqual(notificationEventSchema.options.map(event => ({
    event, description: NOTIFICATION_EVENT_DESCRIPTIONS[event],
  })))
  expect(parsed.every((e: { event: string; description: string }) => e.event && e.description)).toBeTruthy()
})
