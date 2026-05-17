/**
 * Shared `globalThis.fetch` shim used across web tests.
 *
 * The hey-api SDK calls `fetch(new Request(url, init))` instead of the
 * legacy `fetch(url, init)`. These helpers normalize both call shapes so
 * test assertions can keep their pre-migration `(url, init)` signature
 * without each test reaching into `Request` internals.
 */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const body = await input
        .clone()
        .text()
        .then((t) => (t.length ? t : undefined))
        .catch(() => undefined)
      const headersObj: Record<string, string> = {}
      input.headers.forEach((v, k) => {
        headersObj[k] = v
      })
      return handler(input.url, { method: input.method, headers: headersObj, body })
    }
    return handler(String(input), init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

/** Strip scheme + host so tests can assert on path-only URLs. */
export function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '') || url
}

/** Sugar for building a JSON Response. */
export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
