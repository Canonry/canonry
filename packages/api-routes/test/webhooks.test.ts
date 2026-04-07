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

test('resolveWebhookTarget accepts loopback literal addresses', async () => {
  for (const [url, address] of [
    ['http://127.0.0.1/hook', '127.0.0.1'],
    ['http://[::1]/hook', '::1'],
  ] as const) {
    const result = await resolveWebhookTarget(url)
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
