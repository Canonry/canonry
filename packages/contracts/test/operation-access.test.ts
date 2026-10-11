import { describe, expect, it } from 'vitest'
import {
  LIVE_READ_OPERATIONS,
  READ_SEMANTIC_OPERATIONS,
  maxOperationAccess,
  operationAccess,
} from '../src/operation-access.js'

describe('operation access classification', () => {
  it('classifies provider reads, stored reads, semantic previews, and writes', () => {
    expect(operationAccess('get', '/api/v1/projects/{name}/google/properties')).toBe('live')
    expect(operationAccess('get', '/api/v1/projects/{name}/competitors')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/measurement-plan/compile-preview')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/measurement-discovery')).toBe('live')
    expect(operationAccess('delete', '/api/v1/projects/{name}/agent/transcript')).toBe('write')
  })

  it('uses the declared precedence for compound tool operations', () => {
    expect(maxOperationAccess(['stored', 'live'])).toBe('live')
    expect(maxOperationAccess(['live', 'write'])).toBe('write')
    expect(maxOperationAccess([])).toBe('stored')
  })

  it('keeps semantic reads as a subset of the explicit route table', () => {
    expect(READ_SEMANTIC_OPERATIONS.size).toBe(6)
    for (const operation of READ_SEMANTIC_OPERATIONS) expect(operation).not.toBe('')
    for (const operation of READ_SEMANTIC_OPERATIONS) expect(LIVE_READ_OPERATIONS.has(operation)).toBe(false)
  })
})
