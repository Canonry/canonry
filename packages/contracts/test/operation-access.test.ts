import { describe, expect, it } from 'vitest'
import {
  LIVE_READ_OPERATIONS,
  OperationAccesses,
  READ_SEMANTIC_OPERATIONS,
  maxOperationAccess,
  operationAccess,
} from '../src/operation-access.js'

describe('operation access classification', () => {
  it('classifies provider reads, stored reads, semantic previews, and writes', () => {
    expect(operationAccess('get', '/api/v1/projects/{name}/google/properties')).toBe('live')
    expect(operationAccess('get', '/api/v1/projects/{name}/competitors')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/measurement-plan/compile-preview')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/measurement-plan/draft/actions/preview-route-markets')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/measurement-discovery')).toBe('live')
    expect(operationAccess('post', '/api/v1/projects/{name}/competitor-changes/preview')).toBe('stored')
    expect(operationAccess('post', '/api/v1/projects/{name}/queries/replace-preview')).toBe('stored')
    expect(operationAccess('delete', '/api/v1/projects/{name}/agent/transcript')).toBe('write')
  })

  it('uses the declared precedence for compound tool operations', () => {
    expect(maxOperationAccess(['stored', 'live'])).toBe('live')
    expect(maxOperationAccess(['live', 'write'])).toBe('write')
    expect(maxOperationAccess([])).toBe('stored')
  })

  it('classifies every declared semantic preview as stored and not live', () => {
    expect([...READ_SEMANTIC_OPERATIONS].every(operation => {
      const separator = operation.indexOf(' ')
      return separator > 0
        && operationAccess(operation.slice(0, separator), operation.slice(separator + 1)) === OperationAccesses.stored
        && !LIVE_READ_OPERATIONS.has(operation)
    })).toBe(true)
  })
})
