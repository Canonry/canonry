import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { agentProviderIdSchema, configSpecSchema, projectUpsertRequestSchema } from '@canonry/canonry-contracts'
import { buildAgentProvidersResponse, coerceAgentProvider } from '../src/agent/providers.js'
import type { CanonryConfig } from '../src/config.js'
import { invokeCli } from './cli-test-utils.js'

describe('native provider configuration and CLI', () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-native-provider-cli-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', directory)
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
    vi.stubEnv('CI', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('has no generic connection config or per-project research default', () => {
    expectTypeOf<CanonryConfig>().not.toHaveProperty('engineRoutes')
    expect(Object.keys(projectUpsertRequestSchema.shape)).not.toContain('researchProvider')
    expect(Object.keys(configSpecSchema.shape)).not.toContain('researchProvider')
  })

  it('does not adopt generic route IDs into Aero from unknown config fields', () => {
    const config = {
      providers: { 'route:example': { apiKey: 'test-only-key' } },
      engineRoutes: {
        connections: [{ id: 'example', apiKey: 'test-only-key' }],
        routes: [{ id: 'route:example', modelId: 'example-model' }],
      },
    }
    const response = buildAgentProvidersResponse(config)
    expect(response.providers.some(provider => provider.id.startsWith('route:'))).toBe(false)
    expect(response.defaultProvider).not.toBe('route:example')
    expect(agentProviderIdSchema.safeParse('route:example').success).toBe(false)
    expect(coerceAgentProvider('route:example')).toBeUndefined()
  })

  it.each(['engine-routes', 'engine-connection', 'engine-models', 'engine-route'])('does not expose settings %s', async subcommand => {
    const result = await invokeCli(['settings', subcommand, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR' } })
  })
})
