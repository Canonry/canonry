import { test, expect } from 'vitest'
import { resolveWebhookTarget } from '../src/webhooks.js'

test('resolveWebhookTarget rejects private and unspecified literal addresses', async () => {
  for (const url of [
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://0.0.0.0/hook',
    'http://[fc00::1]/hook',
    'http://[::]/hook',
  ]) {
    const result = await resolveWebhookTarget(url)
    expect(result.ok).toBe(false)
  }
})

test('resolveWebhookTarget rejects loopback literal addresses by default', async () => {
  for (const url of [
    'http://127.0.0.1/hook',
    'http://127.255.255.254/hook',
    'http://[::1]/hook',
    // IPv4-mapped IPv6 loopback
    'http://[::ffff:127.0.0.1]/hook',
  ]) {
    const result = await resolveWebhookTarget(url)
    expect(result.ok, `expected ${url} to be blocked`).toBe(false)
  }
})

test('resolveWebhookTarget accepts loopback when allowLoopback is true', async () => {
  for (const [url, address] of [
    ['http://127.0.0.1/hook', '127.0.0.1'],
    ['http://[::1]/hook', '::1'],
  ] as const) {
    const result = await resolveWebhookTarget(url, { allowLoopback: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target.address).toBe(address)
    }
  }
})

test('resolveWebhookTarget accepts public literal addresses', async () => {
  const result = await resolveWebhookTarget('https://8.8.8.8/hook')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.target.address).toBe('8.8.8.8')
  }
})

test('resolveWebhookTarget accepts IPv4 private ranges when allowPrivateNetworks is true', async () => {
  for (const [url, address] of [
    ['http://10.0.0.5/hook', '10.0.0.5'],
    ['http://172.16.0.10/hook', '172.16.0.10'],
    ['http://192.168.1.10/hook', '192.168.1.10'],
  ] as const) {
    const result = await resolveWebhookTarget(url, { allowPrivateNetworks: true })
    expect(result.ok, `expected ${url} to be allowed`).toBe(true)
    if (result.ok) {
      expect(result.target.address).toBe(address)
    }
  }
})

test('resolveWebhookTarget accepts IPv6 ULA + link-local when allowPrivateNetworks is true', async () => {
  // Symmetric with the IPv4 opt-in — operators routing the control plane
  // over an IPv6 Docker bridge / VPN need the same escape hatch.
  for (const [url, address] of [
    ['http://[fc00::1]/hook', 'fc00::1'],
    ['http://[fd12:3456:789a::1]/hook', 'fd12:3456:789a::1'],
    ['http://[fe80::1]/hook', 'fe80::1'],
  ] as const) {
    const result = await resolveWebhookTarget(url, { allowPrivateNetworks: true })
    expect(result.ok, `expected ${url} to be allowed`).toBe(true)
    if (result.ok) {
      expect(result.target.address).toBe(address)
    }
  }
})

test('resolveWebhookTarget still rejects IPv6 :: even when allowPrivateNetworks is true', async () => {
  // The unspecified address is never legitimate; the opt-in must not
  // unlock it.
  const result = await resolveWebhookTarget('http://[::]/hook', { allowPrivateNetworks: true })
  expect(result.ok).toBe(false)
})
