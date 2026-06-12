import { test, expect } from 'vitest'

import { getBootstrapEnv, getPlatformEnv } from '../src/index.js'

const baseEnv = { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } as NodeJS.ProcessEnv

test('getBootstrapEnv threads GEMINI_BASE_URL / OPENAI_BASE_URL into provider configs', () => {
  const env = getBootstrapEnv({
    ...baseEnv,
    GEMINI_BASE_URL: 'https://gemini-proxy.example.com',
    OPENAI_BASE_URL: 'https://openai-proxy.example.com',
  })
  expect(env.providers.gemini?.baseUrl).toBe('https://gemini-proxy.example.com')
  expect(env.providers.openai?.baseUrl).toBe('https://openai-proxy.example.com')
})

test('getBootstrapEnv leaves provider baseUrl undefined when the env var is unset', () => {
  const env = getBootstrapEnv(baseEnv)
  expect(env.providers.gemini?.baseUrl).toBeUndefined()
  expect(env.providers.openai?.baseUrl).toBeUndefined()
})

test('getPlatformEnv threads GEMINI_BASE_URL / OPENAI_BASE_URL into provider configs', () => {
  const env = getPlatformEnv({
    ...baseEnv,
    GEMINI_BASE_URL: 'https://gemini-proxy.example.com',
    OPENAI_BASE_URL: 'https://openai-proxy.example.com',
  } as NodeJS.ProcessEnv)
  expect(env.providers.gemini?.baseUrl).toBe('https://gemini-proxy.example.com')
  expect(env.providers.openai?.baseUrl).toBe('https://openai-proxy.example.com')
})

test('getPlatformEnv leaves provider baseUrl undefined when the env var is unset', () => {
  const env = getPlatformEnv(baseEnv)
  expect(env.providers.gemini?.baseUrl).toBeUndefined()
  expect(env.providers.openai?.baseUrl).toBeUndefined()
})
