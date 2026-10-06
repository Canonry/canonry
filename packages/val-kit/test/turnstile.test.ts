import { test } from 'vitest'
import {
  createTurnstileVerifier,
  HumanVerificationError,
} from '../src/security/turnstile.js'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

async function rejects(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected promise rejection')
}

function verifierWithAction(action: string) {
  return createTurnstileVerifier({
    secret: 'test-secret',
    allowedHostnames: ['demo.example.com'],
    fetchImpl: () =>
      Promise.resolve(new Response(JSON.stringify({ success: true, action, hostname: 'demo.example.com' }))),
  })
}

test('Turnstile verifier enforces the fixed audit action', async () => {
  await verifierWithAction('audit').verify({ token: 'token', remoteIp: null })
  const error = await rejects(() =>
    verifierWithAction('client-controlled-action').verify({ token: 'token', remoteIp: null })
  )
  if (!(error instanceof HumanVerificationError)) throw error
  equal(error.code, 'invalid')
  equal(error.message, 'Human verification did not match this check.')
})
