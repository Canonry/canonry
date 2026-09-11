import { expect, test } from 'vitest'

import { UserRoles } from '@ainyc/canonry-contracts'
import { accountPrincipalCacheKey } from '../src/components/auth/AuthGate.js'
import { accountStateForApiKey } from '../src/contexts/account-context.js'

test('principal cache identity changes with a user auth version or role', () => {
  const initial = accountPrincipalCacheKey({ id: 'user-1', name: 'sam', authVersion: 2, role: UserRoles.analyst })
  expect(accountPrincipalCacheKey({ id: 'user-1', name: 'sam', authVersion: 3, role: UserRoles.analyst })).not.toBe(initial)
  expect(accountPrincipalCacheKey({ id: 'user-1', name: 'sam', authVersion: 2, role: UserRoles.viewer })).not.toBe(initial)
})

test('a Research key receives only Research controls', () => {
  expect(accountStateForApiKey({ id: 'key', scopes: ['research.run'], projectId: null, readOnly: false }))
    .toMatchObject({ canWrite: false, canResearch: true, isAdmin: false })
})

test('an unrelated or read-only key cannot run Research', () => {
  for (const key of [{ scopes: ['ads.write'], readOnly: false }, { scopes: ['research.run'], readOnly: true }]) {
    expect(accountStateForApiKey({ id: 'key', projectId: null, ...key }))
      .toMatchObject({ canWrite: false, canResearch: false, isAdmin: false })
  }
})
