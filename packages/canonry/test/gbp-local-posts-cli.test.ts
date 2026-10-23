import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { gbpLocalPosts } from '../src/commands/gbp.js'

vi.mock('../src/client.js', async (original) => {
  const actual = await original<typeof import('../src/client.js')>()
  return {
    ...actual,
    createApiClient: () =>
      new actual.ApiClient('http://127.0.0.1:1', 'fixture'),
  }
})
afterEach(() => vi.restoreAllMocks())
describe('GBP attempt recovery CLI routing', () => {
  it('uses the stored attempt GET without requesting a create JSON file', async () => {
    const get = vi
      .spyOn(ApiClient.prototype, 'getGbpLocalPostAttempt')
      .mockResolvedValue({
        attemptId: '00000000-0000-4000-8000-000000000001',
        packageId: 'a'.repeat(64),
        status: 'uncertain',
        post: null,
      })
    const create = vi.spyOn(ApiClient.prototype, 'createGbpLocalPost')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await gbpLocalPosts('one', 'attempt', {
      attempt: '00000000-0000-4000-8000-000000000001',
      package: 'a'.repeat(64),
    })
    expect(get).toHaveBeenCalledWith(
      'one',
      '00000000-0000-4000-8000-000000000001',
      'a'.repeat(64),
    )
    expect(create).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0]![0] as string).status).toBe('uncertain')
  })
  it('refuses missing bindings and unknown actions without provider access', async () => {
    await expect(gbpLocalPosts('one', 'attempt', {})).rejects.toThrow(
      '--attempt',
    )
    await expect(gbpLocalPosts('one', 'typo', {})).rejects.toThrow('Unknown')
  })
})
