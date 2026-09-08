import { createServer, type ServerResponse } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'

import { ApiClient } from '../src/client.js'
import { CliError, printCliError } from '../src/cli-error.js'

const closeCallbacks: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(closeCallbacks.splice(0).map(close => close()))
})

test('research daily-limit API errors keep their typed code and render through the CLI', async () => {
  const server = createServer((_request, response: ServerResponse) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      error: {
        code: 'RESEARCH_DAILY_LIMIT_EXCEEDED',
        message: 'The viewer research run limit for this project has been reached today (20). Try again tomorrow or ask an administrator.',
        details: { projectName: 'demo', limit: 20, date: '2026-09-08' },
      },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start test API')
  closeCallbacks.push(() => new Promise(resolve => server.close(() => resolve())))

  const client = new ApiClient(`http://127.0.0.1:${address.port}`, 'cnry_test', { skipProbe: true })
  let thrown: unknown
  try {
    await client.startResearchRun('demo', { queries: ['A test query'] })
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(CliError)
  expect(thrown).toMatchObject({
    code: 'RESEARCH_DAILY_LIMIT_EXCEEDED',
    exitCode: 1,
    details: { projectName: 'demo', limit: 20, date: '2026-09-08', httpStatus: 429 },
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  printCliError(thrown as CliError, 'json')
  expect(JSON.parse(consoleError.mock.calls[0]!.join(' '))).toEqual({
    error: {
      code: 'RESEARCH_DAILY_LIMIT_EXCEEDED',
      message: 'The viewer research run limit for this project has been reached today (20). Try again tomorrow or ask an administrator.',
      details: { projectName: 'demo', limit: 20, date: '2026-09-08', httpStatus: 429 },
    },
  })
})
