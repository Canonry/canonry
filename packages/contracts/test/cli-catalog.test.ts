import { describe, expect, it } from 'vitest'
import { cliCatalogSchema } from '../src/cli-catalog.js'

const catalog = {
  version: '1.0.0', globalOptions: [{ name: 'format', type: 'string', multiple: false }],
  groups: [{ root: 'ga', section: 'Integrations', summary: 'Read stored analytics', commands: [{
    id: 'ga.acquisition', path: ['ga', 'acquisition'], usage: 'canonry ga acquisition <project>',
    access: 'stored', supportsDryRun: false, windows: ['7d', '30d', '90d', 'all'], options: [{ name: 'source', type: 'string', multiple: false }],
  }] }],
}
describe('CLI catalog public contract', () => {
  it('preserves command identity, capability flags, choices and option cardinality', () => {
    expect(cliCatalogSchema.parse(catalog)).toEqual(catalog)
  })
  it('rejects malformed command and option metadata', () => {
    const command = catalog.groups[0]!.commands[0]!
    for (const change of [{ path: [] }, { supportsDryRun: 'yes' }, { options: [{ name: 'source', type: 'number', multiple: false }] }]) {
      expect(cliCatalogSchema.safeParse({ ...catalog, groups: [{ ...catalog.groups[0], commands: [{ ...command, ...change }] }] }).success).toBe(false)
    }
  })
})
