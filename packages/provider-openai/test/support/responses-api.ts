import { vi } from 'vitest'

export interface CapturedResponseRequest {
  url: string
  method: string
  authorization: string | null
  body: unknown
}

/** The real SDK builds the request and augments its response; this stub does neither. */
export function stubResponsesApi(response: Record<string, unknown>): CapturedResponseRequest[] {
  const sent: CapturedResponseRequest[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    sent.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    })
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return sent
}
