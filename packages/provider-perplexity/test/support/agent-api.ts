import { readFileSync } from 'node:fs'
import { vi } from 'vitest'

export interface CapturedAgentRequest {
  url: string
  method: string
  authorization: string | null
  body: Record<string, unknown>
}

/** Literal schema-derived fixtures, never live captures or owner-produced expectations. */
export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))
}

/** The installed OpenAI client builds and parses the HTTP exchange; this stub does neither. */
export function stubAgentHttp(status: number, body: Record<string, unknown>): CapturedAgentRequest[] {
  const calls: CapturedAgentRequest[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}
