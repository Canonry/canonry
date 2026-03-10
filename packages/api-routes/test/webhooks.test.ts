import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWebhookTarget } from '../src/webhooks.js'

test('resolveWebhookTarget rejects loopback and private literal addresses', async () => {
  for (const url of [
    'http://127.0.0.1/hook',
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://[::1]/hook',
    'http://[fc00::1]/hook',
  ]) {
    const result = await resolveWebhookTarget(url)
    assert.equal(result.ok, false)
  }
})

test('resolveWebhookTarget accepts public literal addresses', async () => {
  const result = await resolveWebhookTarget('https://8.8.8.8/hook')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.target.address, '8.8.8.8')
  }
})
