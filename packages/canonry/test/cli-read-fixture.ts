import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { invokeCli } from './cli-test-utils.js'

/** Exercise the registered CLI, real config factory and generated SDK. Only HTTP is supplied. */
export function prepareCliReadFixture(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cli-read-'))
  fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({
    apiUrl: 'https://canonry.test', basePath: '/prefix', apiKey: 'cnry_native-read',
    database: path.join(dir, 'canonry.db'), providers: {}, telemetry: { enabled: false },
  }))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_BASE_PATH', '/prefix')
  vi.stubEnv('CANONRY_PORT', '')
  vi.stubEnv('CANONRY_TRACE', '')
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
  return () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function invokeCliRead(args: string[], payload: unknown, expected: {
  pathname: string
  query?: Record<string, string>
  status?: number
}) {
  const requests: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init))
    return Response.json(payload, { status: expected.status ?? 200 })
  }))
  const result = await invokeCli(args)
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  const url = new URL(request.url)
  expect(url.origin).toBe('https://canonry.test')
  expect(url.pathname).toBe(expected.pathname)
  expect(Object.fromEntries(url.searchParams)).toEqual(expected.query ?? {})
  expect(request.method).toBe('GET')
  expect(request.headers.get('authorization')).toBe('Bearer cnry_native-read')
  return result
}
