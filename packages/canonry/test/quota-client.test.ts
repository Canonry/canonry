/**
 * Tests for the lease-aware quota client (Track 1 — Canonry Hosted).
 *
 * Every test mocks `fetch` with `vi.fn()` so no live control-plane call
 * leaves the process. The vitest-defaults setup file already blocks
 * non-localhost requests; we use a localhost-shaped base URL for the
 * happy paths to keep that guard satisfied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  QuotaClient,
  QuotaExceededError,
  QuotaUnavailableError,
  createQuotaClientFromEnv,
} from '../src/quota/index.js'

const BASE = 'http://localhost:18080'
const KEY = 'cnry_test'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('QuotaClient.check (RPC mode)', () => {
  it('issues a POST to /quota/check with the documented body shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ allowed: true, remaining: 99 }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.check({
      tenantId: 't1',
      projectSlug: 'p1',
      scope: 'sweeps_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })

    expect(result).toEqual({ allowed: true, remaining: 99 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/quota/check`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    })
    expect(JSON.parse(init.body as string)).toEqual({
      tenant_id: 't1',
      project_slug: 'p1',
      scope: 'sweeps_per_tenant_per_month',
      metric_key: '*',
      amount: 1,
    })
  })

  it('parses an HTTP 429 body as allowed=false + resetsAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ resets_at: '2026-06-01T00:00:00Z', remaining: 0 }, 429),
    )
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.check({
      tenantId: 't1',
      scope: 'sweeps_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })

    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      resetsAt: '2026-06-01T00:00:00Z',
    })
  })

  it('parses {allowed:false} from a 200 response', async () => {
    // Newer control-plane builds prefer a 200 envelope with allowed:false
    // (clearer signalling than HTTP 429 which clients sometimes coerce
    // into "retry"). Spec accepts both.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ allowed: false, remaining: 0 }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.check({
      tenantId: 't1',
      scope: 'discovery_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })
    expect(result.allowed).toBe(false)
  })

  it('fails closed when the control plane is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    await expect(client.check({
      tenantId: 't1',
      scope: 'sweeps_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })).rejects.toBeInstanceOf(QuotaUnavailableError)
  })

  it('fails closed when controlPlaneUrl is missing', async () => {
    const client = new QuotaClient({ controlPlaneUrl: undefined, apiKey: KEY })
    await expect(client.check({
      tenantId: 't1',
      scope: 'sweeps_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })).rejects.toBeInstanceOf(QuotaUnavailableError)
  })

  it('checkOrThrow rejects with QuotaExceededError on allowed=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ allowed: false, remaining: 0, resets_at: '2026-07-01T00:00:00Z' }),
    )
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    await expect(client.checkOrThrow({
      tenantId: 't1',
      scope: 'action_executions_per_tenant_per_month',
      metricKey: 'github-pr',
      amount: 1,
    })).rejects.toMatchObject({
      name: 'QuotaExceededError',
      scope: 'action_executions_per_tenant_per_month',
      resetsAt: '2026-07-01T00:00:00Z',
    })
  })
})

describe('QuotaClient.acquireLease (lease mode)', () => {
  it('issues a POST to /quota/lease and returns the granted lease', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      lease_id: 'lease_xxx',
      granted_amount: 100_000,
      expires_at: '2026-06-01T00:15:00Z',
    }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const grant = await client.acquireLease({
      tenantId: 't1',
      scope: 'provider_tokens_per_tenant_per_month',
      metricKey: '*',
      requestedAmount: 100_000,
      maxDurationSeconds: 900,
    })

    expect(grant).toEqual({
      leaseId: 'lease_xxx',
      grantedAmount: 100_000,
      expiresAt: '2026-06-01T00:15:00Z',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/quota/lease`)
    expect(JSON.parse(init.body as string)).toMatchObject({
      tenant_id: 't1',
      scope: 'provider_tokens_per_tenant_per_month',
      metric_key: '*',
      requested_amount: 100_000,
      max_duration_seconds: 900,
    })
  })

  it('forwards idempotencyKey to the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      lease_id: 'lease_xxx', granted_amount: 100, expires_at: '2026-06-01T00:00:00Z',
    }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    await client.acquireLease({
      tenantId: 't1',
      scope: 'gsc_per_site_per_day',
      metricKey: 'site:example.com',
      requestedAmount: 100,
      maxDurationSeconds: 60,
      idempotencyKey: 'idem-1',
    })

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).idempotency_key).toBe('idem-1')
  })

  it('throws QuotaExceededError on HTTP 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ resets_at: '2026-07-01T00:00:00Z' }, 429),
    )
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    await expect(client.acquireLease({
      tenantId: 't1',
      scope: 'provider_tokens_per_tenant_per_month',
      metricKey: '*',
      requestedAmount: 1_000,
      maxDurationSeconds: 60,
    })).rejects.toBeInstanceOf(QuotaExceededError)
  })

  describe('degraded-mode reserve (fail-open)', () => {
    it('falls back to 10% of last grant when the control plane is unreachable', async () => {
      const fetchMock = vi.fn()
      // First call succeeds — primes the reserve.
      fetchMock.mockResolvedValueOnce(jsonResponse({
        lease_id: 'lease_1', granted_amount: 10_000, expires_at: '2026-06-01T00:15:00Z',
      }))
      // Second call fails with a network error.
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

      const first = await client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 10_000,
        maxDurationSeconds: 900,
      })
      expect(first.grantedAmount).toBe(10_000)

      // Outage path — get 10% of last grant = 1000 tokens.
      const degraded = await client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 5_000,
        maxDurationSeconds: 900,
      })
      expect(degraded.grantedAmount).toBe(1_000)
      expect(degraded.leaseId.startsWith('degraded-')).toBe(true)
    })

    it('exhausts the reserve across multiple degraded-mode calls', async () => {
      const fetchMock = vi.fn()
      fetchMock.mockResolvedValueOnce(jsonResponse({
        lease_id: 'lease_1', granted_amount: 1_000, expires_at: '2026-06-01T00:15:00Z',
      }))
      // All subsequent calls fail — operator never sees the control plane recover.
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

      const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

      await client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 1_000,
        maxDurationSeconds: 900,
      })
      // Reserve is now 100 (10% of 1000).
      const first = await client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 60,
        maxDurationSeconds: 60,
      })
      expect(first.grantedAmount).toBe(60)
      // 40 left.
      const second = await client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 40,
        maxDurationSeconds: 60,
      })
      expect(second.grantedAmount).toBe(40)
      // 0 left — next call must throw.
      await expect(client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 1,
        maxDurationSeconds: 60,
      })).rejects.toBeInstanceOf(QuotaUnavailableError)
    })

    it('throws QuotaUnavailableError when no prior grant exists', async () => {
      // First-call outage — no reserve to fall back on yet.
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

      await expect(client.acquireLease({
        tenantId: 't1',
        scope: 'provider_tokens_per_tenant_per_month',
        metricKey: '*',
        requestedAmount: 1_000,
        maxDurationSeconds: 60,
      })).rejects.toMatchObject({
        name: 'QuotaUnavailableError',
        reason: 'lease-reserve-exhausted',
      })
    })

    it('reserve is per (scope, metricKey) — two sites do not share', async () => {
      const fetchMock = vi.fn()
      fetchMock.mockResolvedValueOnce(jsonResponse({
        lease_id: 'l1', granted_amount: 500, expires_at: '2026-06-01T00:15:00Z',
      }))
      // Second metricKey: control plane fails immediately.
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

      // Prime site A.
      await client.acquireLease({
        tenantId: 't1',
        scope: 'gsc_per_site_per_day',
        metricKey: 'site:a.com',
        requestedAmount: 500,
        maxDurationSeconds: 900,
      })

      // Site B has no prior grant — must throw, not borrow site A's reserve.
      await expect(client.acquireLease({
        tenantId: 't1',
        scope: 'gsc_per_site_per_day',
        metricKey: 'site:b.com',
        requestedAmount: 100,
        maxDurationSeconds: 900,
      })).rejects.toBeInstanceOf(QuotaUnavailableError)
    })
  })
})

describe('QuotaClient.closeLease', () => {
  it('posts to /quota/lease/{id}/close with the used amount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ refunded: 250 }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.closeLease('lease_xxx', { usedAmount: 750 })
    expect(result).toEqual({ refunded: 250 })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/quota/lease/lease_xxx/close`)
    expect(JSON.parse(init.body as string)).toEqual({ used_amount: 750 })
  })

  it('url-encodes the lease id (defensive)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ refunded: 0 }))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    await client.closeLease('weird/lease id', { usedAmount: 0 })
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/quota/lease/weird%2Flease%20id/close`)
  })

  it('synthetic degraded-* leases skip the network round-trip', async () => {
    const fetchMock = vi.fn()
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.closeLease('degraded-x-1234-abcd', { usedAmount: 10 })
    expect(result).toEqual({ refunded: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a transport error as best-effort (returns refunded: 0)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new QuotaClient({ controlPlaneUrl: BASE, apiKey: KEY, fetch: fetchMock })

    const result = await client.closeLease('lease_xxx', { usedAmount: 100 })
    expect(result).toEqual({ refunded: 0 })
  })
})

describe('createQuotaClientFromEnv', () => {
  const originalUrl = process.env.CANONRY_CONTROL_PLANE_URL
  const originalKey = process.env.CANONRY_API_KEY

  beforeEach(() => {
    delete process.env.CANONRY_CONTROL_PLANE_URL
    delete process.env.CANONRY_API_KEY
  })

  afterEach(() => {
    if (originalUrl !== undefined) process.env.CANONRY_CONTROL_PLANE_URL = originalUrl
    if (originalKey !== undefined) process.env.CANONRY_API_KEY = originalKey
  })

  it('reads CANONRY_CONTROL_PLANE_URL and CANONRY_API_KEY from env', () => {
    const client = createQuotaClientFromEnv({
      CANONRY_CONTROL_PLANE_URL: 'http://canonry-control-plane:8080/',
      CANONRY_API_KEY: 'cnry_xxx',
    })
    // Trailing slashes are stripped so paths concat cleanly.
    expect((client as unknown as { controlPlaneUrl: string }).controlPlaneUrl).toBe(
      'http://canonry-control-plane:8080',
    )
  })

  it('returns a client whose calls fail closed when both env vars are missing', async () => {
    const client = createQuotaClientFromEnv({})
    await expect(client.check({
      tenantId: 't1',
      scope: 'sweeps_per_tenant_per_month',
      metricKey: '*',
      amount: 1,
    })).rejects.toBeInstanceOf(QuotaUnavailableError)
  })
})
