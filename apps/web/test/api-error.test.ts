import { describe, it, expect } from 'vitest'
import { ApiError } from '../src/api.js'

describe('ApiError', () => {
  it('preserves error code and status', () => {
    const err = new ApiError('Not found', 404, 'NOT_FOUND')
    expect(err.message).toBe('Not found')
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.name).toBe('ApiError')
    expect(err).toBeInstanceOf(Error)
  })

  it('defaults code to UNKNOWN when not provided', () => {
    const err = new ApiError('Server error', 500)
    expect(err.code).toBe('UNKNOWN')
  })
})
