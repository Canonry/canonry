import { expect, it, vi } from 'vitest'
import { resolveEffectiveAuthorization } from '../src/mcp/cli.js'
import { getCanonryMcpTools } from '../src/mcp/server.js'

const internal = ['canonry_logs_list', 'canonry_telemetry_get', 'canonry_telemetry_update']

it('hides internal tools from unknown and customer wildcard credentials', () => {
  for (const scopes of [undefined, ['*'], ['logs.read'], ['*', 'operator']]) {
    const names = getCanonryMcpTools('all', undefined, scopes).map(tool => tool.name)
    for (const name of internal) expect(names).not.toContain(name)
    expect(names).toContain('canonry_projects_list')
  }
})

it('retains read-only narrowing for a host-approved operator', () => {
  const tools = getCanonryMcpTools('read-only', undefined, ['logs.read'], true)
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(internal.slice(0, 2)))
  expect(tools.every(tool => tool.access === 'read')).toBe(true)
})

it('probes operator authority even with --read-only and fails closed on old or unavailable hosts', async () => {
  for (const operator of [undefined, false, true]) {
    const getApiKeySelf = vi.fn().mockResolvedValue({ scopes: ['logs.read'], operator })
    const access = await resolveEffectiveAuthorization({ getApiKeySelf }, 'read-only')
    expect(getApiKeySelf).toHaveBeenCalledOnce()
    expect(access).toMatchObject({ scope: 'read-only', operator: operator === true })
  }
  expect(await resolveEffectiveAuthorization({ getApiKeySelf: vi.fn().mockRejectedValue(new Error('offline')) }, 'all')).toMatchObject({ operator: false })
})
