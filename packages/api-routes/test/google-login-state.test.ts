import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { openGoogleLoginState, sealGoogleLoginState, googleLoginUrls, safeAuthReturnPath } from '../src/google-login-state.js'

const secret = crypto.randomBytes(32).toString('hex')
const base = 'https://instance.example.test/nested/'
const callback = new URL('api/v1/auth/google/callback', base).href
const now = Date.now()
const payload = () => ({ state: crypto.randomUUID(), nonce: crypto.randomUUID(),
  codeVerifier: crypto.randomBytes(32).toString('base64url'), returnTo: '/nested/',
  expiresAt: now + 60_000 })

test('state is authenticated, confidential, short-lived and instance-bound', () => {
  const value = payload()
  const cookie = sealGoogleLoginState(value, secret, callback)
  expect(cookie).not.toContain(value.codeVerifier)
  expect(openGoogleLoginState(cookie, secret, callback, now)).toEqual(value)
  expect(() => openGoogleLoginState(cookie, secret, callback, now + 120_000)).toThrow()
  expect(() => openGoogleLoginState(cookie, secret, callback.replace('instance', 'another'), now)).toThrow()
  expect(() => openGoogleLoginState(cookie, crypto.randomUUID(), callback, now)).toThrow()
  const pieces = cookie.split('.')
  pieces[1] = Buffer.from(crypto.randomBytes(12)).toString('base64url')
  expect(() => openGoogleLoginState(pieces.join('.'), secret, callback, now)).toThrow()
})

test('callback honors an existing public subpath without duplicating it', () => {
  expect(googleLoginUrls(base, '/nested/')).toEqual({
    baseUrl: base, basePath: '/nested/', callbackUrl: callback,
  })
  expect(googleLoginUrls('https://instance.example.test', '/nested/').callbackUrl).toBe(callback)
  expect(() => googleLoginUrls('http://instance.example.test')).toThrow()
  expect(() => googleLoginUrls('https://name:secret@instance.example.test')).toThrow()
  expect(() => googleLoginUrls('https://instance.example.test/a/', '/b/')).toThrow()
})

test('return destinations remain inside the configured instance path', () => {
  const urls = googleLoginUrls(base)
  const valid = '/nested/oauth/authorize?client_id=' + crypto.randomUUID()
  expect(safeAuthReturnPath(valid, urls)).toBe(valid)
  for (const unsafe of ['https://evil.example.test', '//evil.example.test', '/elsewhere/', '/nested/../elsewhere/', '/nested/\\\\evil.example.test', '/nested/%2f%2fevil.example.test']) {
    expect(safeAuthReturnPath(unsafe, urls)).toBe(urls.basePath)
  }
})
