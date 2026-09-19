import { expect, test } from 'vitest'
import {
  READ_ONLY_SCOPE,
  RESEARCH_RUN_SCOPE,
  UserRoles,
  UserStatuses,
  createUserRequestSchema,
  updateUserRequestSchema,
  userRoleScopes,
} from '../src/index.js'

test('named roles map to their explicit capability ceilings', () => {
  expect(userRoleScopes(UserRoles.admin)).toEqual(['*'])
  expect(userRoleScopes(UserRoles.analyst)).toEqual([READ_ONLY_SCOPE, RESEARCH_RUN_SCOPE])
  expect(userRoleScopes(UserRoles.viewer)).toEqual([READ_ONLY_SCOPE])
})

test('account requests accept the account foundation role/status/profile fields', () => {
  expect(createUserRequestSchema.parse({
    name: 'analyst_1',
    password: 'a-suitably-long-password',
    role: UserRoles.analyst,
    displayName: 'Analyst One',
    email: 'analyst@example.test',
  }).role).toBe(UserRoles.analyst)
  expect(updateUserRequestSchema.parse({
    status: UserStatuses.suspended,
    displayName: null,
    email: null,
  })).toMatchObject({ status: UserStatuses.suspended, displayName: null, email: null })
})
