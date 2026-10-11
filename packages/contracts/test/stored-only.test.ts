import { describe, expect, it } from 'vitest'
import { matchOperationTemplate, operationAccess } from '../src/operation-access.js'

describe('stored-only operation matching', () => {
  it('matches proxy-prefixed provider URLs and semantic previews', () => {
    expect(matchOperationTemplate('GET', 'https://host/canonry/api/v1/projects/acme/google/properties')).toBe('GET /api/v1/projects/{name}/google/properties')
    expect(operationAccess(...matchOperationTemplate('POST', '/canonry/api/v1/projects/acme/measurement-plan/compile-preview').split(' ', 2) as [string, string])).toBe('stored')
  })
})
