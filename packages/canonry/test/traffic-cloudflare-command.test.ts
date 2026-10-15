import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  TrafficConnectCloudflareRequest,
  TrafficConnectCloudflareResponse,
  TrafficSourceDto,
} from '@canonry/canonry-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli-error.js'
import type { CanonryConfig } from '../src/config.js'
import { trafficActivate, trafficConnectCloudflare } from '../src/commands/traffic.js'

const response: TrafficConnectCloudflareResponse = {
  sourceId: 'source-cloudflare-test',
  deliveryMode: 'direct-push',
  workerScript: 'export default { async fetch(request, env) { return fetch(request) } }',
  wranglerToml: 'main = "worker.js"\n[secrets]\nrequired = ["CANONRY_BEARER_TOKEN", "CANONRY_HMAC_SECRET"]\n',
  workerVersion: '1.0.0',
  instructions: 'Attach `example.com/*` manually. Set Request limit failure mode to Fail open before activation.',
}

const queueResponse: TrafficConnectCloudflareResponse = {
  sourceId: 'source-cloudflare-queue-test',
  deliveryMode: 'queue-pull',
  activationRequired: true,
  accountId: 'account_queue',
  queueId: 'queue_id',
  queueName: 'canonry-traffic',
  retentionSeconds: 345_600,
  workerScript: 'export default { async fetch(request, env) { return fetch(request) } }',
  wranglerToml: 'main = "worker.js"\n[[queues.producers]]\nqueue = "canonry-traffic"\n',
  workerVersion: '1.0.0',
  instructions: 'Deploy the Worker, then activate queue delivery.',
}

const activatedQueueSource: TrafficSourceDto = {
  id: queueResponse.sourceId,
  projectId: 'project-demo',
  sourceType: 'cloudflare',
  displayName: 'Cloudflare Queue',
  status: 'connected',
  lastSyncedAt: null,
  lastCursor: null,
  lastError: null,
  skippedThroughAt: null,
  queueBacklogCount: null,
  queueBacklogObservedAt: null,
  archivedAt: null,
  config: {
    deliveryMode: 'queue-pull',
    queueName: queueResponse.queueName,
  },
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:01:00.000Z',
}

const scratchDirectories: string[] = []

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cloudflare-command-test-'))
  scratchDirectories.push(directory)
  return directory
}

function localConfig(bearerToken: string, hmacSecret: string): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    cloudflareTraffic: {
      connections: [{
        // Source identity survives project rename; deployment lookup must not
        // fall back to projectName after the connect response returns sourceId.
        projectName: 'renamed-project',
        sourceId: response.sourceId,
        deliveryMode: 'direct-push',
        bearerToken,
        hmacSecret,
        workerVersion: response.workerVersion,
        expectedBotListVersion: '2026-08-09',
        zoneId: 'zone_test',
        accountId: null,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }],
    },
  }
}

function queueLocalConfig(apiToken: string): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    cloudflareTraffic: {
      connections: [{
        projectName: 'demo',
        sourceId: queueResponse.sourceId,
        deliveryMode: 'queue-pull',
        apiToken,
        queueId: queueResponse.queueId,
        queueName: queueResponse.queueName,
        retentionSeconds: queueResponse.retentionSeconds,
        workerVersion: queueResponse.workerVersion,
        expectedBotListVersion: '2026-08-09',
        zoneId: 'zone_test',
        accountId: queueResponse.accountId,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }],
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of scratchDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('trafficConnectCloudflare', () => {
  it('emits only a sanitized summary and writes no local secret to either artifact', async () => {
    const bearerToken = 'cnry_cfw_command-bearer-secret'
    const hmacSecret = 'command-hmac-secret'
    const outputDirectory = path.join(scratch(), 'worker')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory,
      format: 'json',
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig(bearerToken, hmacSecret),
    })

    const stdout = logs.join('\n')
    const workerScript = fs.readFileSync(path.join(outputDirectory, 'worker.js'), 'utf-8')
    const wranglerToml = fs.readFileSync(path.join(outputDirectory, 'wrangler.toml'), 'utf-8')
    for (const output of [stdout, workerScript, wranglerToml]) {
      expect(output).not.toContain(bearerToken)
      expect(output).not.toContain(hmacSecret)
    }
    expect(stdout).not.toContain(response.workerScript)
    expect(JSON.parse(stdout)).toMatchObject({
      sourceId: response.sourceId,
      deliveryMode: 'direct-push',
      deployment: 'not-requested',
      routeAttachment: 'required-manual',
      autoDeployAvailable: true,
      requestLimitFailureMode: {
        required: 'fail-open',
        status: 'required-during-manual-route-attachment',
        configuredBy: 'cloudflare-dashboard',
        configuredByWrangler: false,
      },
    })
  })

  it('passes the account id to the connect API', async () => {
    let request: TrafficConnectCloudflareRequest | undefined
    await trafficConnectCloudflare('demo', {
      accountId: 'account_test',
      zoneId: 'zone_test',
      outputDirectory: path.join(scratch(), 'worker'),
      format: 'json',
    }, {
      client: {
        trafficConnectCloudflare: async (_project, body) => {
          request = body
          return response
        },
      },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
    })

    expect(request).toMatchObject({
      deliveryMode: 'direct-push',
      accountId: 'account_test',
      zoneId: 'zone_test',
    })
  })

  it('reads the queue token only from a regular file and keeps it out of output and artifacts', async () => {
    const apiToken = 'cloudflare-queue-api-token-do-not-print'
    const tokenFile = path.join(scratch(), 'queue-token.txt')
    fs.writeFileSync(tokenFile, `${apiToken}\n`, { mode: 0o600 })
    const outputDirectory = path.join(scratch(), 'worker')
    const logs: string[] = []
    let request: TrafficConnectCloudflareRequest | undefined
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      deliveryMode: 'queue-pull',
      accountId: queueResponse.accountId,
      queueId: queueResponse.queueId,
      queueName: queueResponse.queueName,
      apiTokenFile: tokenFile,
      outputDirectory,
      format: 'json',
    }, {
      client: {
        trafficConnectCloudflare: async (_project, body) => {
          request = body
          return queueResponse
        },
      },
      loadLocalConfig: () => queueLocalConfig(apiToken),
    })

    expect(request).toMatchObject({
      deliveryMode: 'queue-pull',
      accountId: queueResponse.accountId,
      queueId: queueResponse.queueId,
      queueName: queueResponse.queueName,
      retentionSeconds: 345_600,
      apiToken,
    })
    const workerScript = fs.readFileSync(path.join(outputDirectory, 'worker.js'), 'utf-8')
    const wranglerToml = fs.readFileSync(path.join(outputDirectory, 'wrangler.toml'), 'utf-8')
    const stdout = logs.join('\n')
    for (const output of [stdout, workerScript, wranglerToml]) {
      expect(output).not.toContain(apiToken)
    }
    expect(JSON.parse(stdout)).toMatchObject({
      deliveryMode: 'queue-pull',
      activationRequired: true,
      autoDeployAvailable: true,
      queuePullConsumer: {
        required: true,
        queueName: queueResponse.queueName,
      },
    })
  })

  it('requires every queue-pull identifier and its token file', async () => {
    await expect(trafficConnectCloudflare('demo', {
      deliveryMode: 'queue-pull',
    }, {
      client: { trafficConnectCloudflare: async () => queueResponse },
    })).rejects.toMatchObject({ code: 'TRAFFIC_CLOUDFLARE_QUEUE_ACCOUNT_REQUIRED' })
  })

  it('scans queue artifacts against the token file even without shared server config', async () => {
    const apiToken = 'cloudflare-queue-api-token-unshared'
    const tokenFile = path.join(scratch(), 'queue-token.txt')
    fs.writeFileSync(tokenFile, apiToken, { mode: 0o600 })

    await expect(trafficConnectCloudflare('demo', {
      deliveryMode: 'queue-pull',
      accountId: queueResponse.accountId,
      queueId: queueResponse.queueId,
      queueName: queueResponse.queueName,
      apiTokenFile: tokenFile,
      outputDirectory: path.join(scratch(), 'worker'),
    }, {
      client: {
        trafficConnectCloudflare: async () => ({
          ...queueResponse,
          workerScript: `const leaked = ${JSON.stringify(apiToken)}`,
        }),
      },
      loadLocalConfig: () => undefined,
    })).rejects.toMatchObject({ code: 'TRAFFIC_CLOUDFLARE_SECRET_EXPOSURE' })
  })

  it('redacts the token-file input from Queue deploy failures without shared server config', async () => {
    const apiToken = 'cloudflare-queue-api-token-deploy-unshared'
    const tokenFile = path.join(scratch(), 'queue-token.txt')
    fs.writeFileSync(tokenFile, apiToken, { mode: 0o600 })

    const error = await trafficConnectCloudflare('demo', {
      deliveryMode: 'queue-pull',
      accountId: queueResponse.accountId,
      queueId: queueResponse.queueId,
      queueName: queueResponse.queueName,
      apiTokenFile: tokenFile,
      outputDirectory: path.join(scratch(), 'worker'),
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
      confirmFailOpen: true,
    }, {
      client: { trafficConnectCloudflare: async () => queueResponse },
      loadLocalConfig: () => undefined,
      preflightWrangler: async () => {},
      deployWorker: async () => {
        throw new Error(`Wrangler diagnostic included ${apiToken}`)
      },
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'TRAFFIC_CLOUDFLARE_DEPLOY_FAILED',
      message: 'Wrangler diagnostic included [REDACTED]',
    })
    expect((error as CliError).displayMessage).toContain('[REDACTED]')
    expect(JSON.stringify(error)).not.toContain(apiToken)
  })

  it('prints the mode-agnostic activation command when activation is required', async () => {
    const apiToken = 'cloudflare-queue-api-token-activate'
    const tokenFile = path.join(scratch(), 'queue-token.txt')
    fs.writeFileSync(tokenFile, apiToken, { mode: 0o600 })
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      deliveryMode: 'queue-pull',
      accountId: queueResponse.accountId,
      queueId: queueResponse.queueId,
      queueName: queueResponse.queueName,
      apiTokenFile: tokenFile,
      outputDirectory: path.join(scratch(), 'worker'),
    }, {
      client: { trafficConnectCloudflare: async () => queueResponse },
      loadLocalConfig: () => queueLocalConfig(apiToken),
    })

    expect(logs.join('\n')).toContain(
      'Activation required: run `canonry traffic activate demo --source source-cloudflare-queue-test`. This command does not activate delivery.',
    )
    expect(logs.join('\n')).toContain(
      'Required: enable HTTP pull with `wrangler queues consumer http add canonry-traffic` before the first sync.',
    )
  })

  it('requires an explicit Fail open acknowledgement before deployment', async () => {
    await expect(trafficConnectCloudflare('demo', {
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
    }, {
      client: { trafficConnectCloudflare: async () => response },
    })).rejects.toMatchObject({
      code: 'TRAFFIC_CLOUDFLARE_FAIL_OPEN_CONFIRMATION_REQUIRED',
    })
  })

  it('does not connect when Wrangler lacks a required deploy flag', async () => {
    const outputDirectory = path.join(scratch(), 'worker')
    let connectCalled = false

    await expect(trafficConnectCloudflare('demo', {
      outputDirectory,
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
      confirmFailOpen: true,
    }, {
      client: {
        trafficConnectCloudflare: async () => {
          connectCalled = true
          return response
        },
      },
      preflightWrangler: async () => { throw new Error('missing --secrets-file') },
    })).rejects.toMatchObject({
      code: 'TRAFFIC_CLOUDFLARE_WRANGLER_UNSUPPORTED',
      message: 'missing --secrets-file',
      displayMessage:
        'Error: Wrangler preflight failed before Canonry changed state.\nmissing --secrets-file',
    })

    expect(connectCalled).toBe(false)
    expect(fs.existsSync(outputDirectory)).toBe(false)
  })

  it('prints the Fail open and source-overlap requirements', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory: path.join(scratch(), 'worker'),
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
    })

    expect(logs.join('\n')).toMatch(/Request limit failure mode to Fail open/)
    expect(logs.join('\n')).toMatch(/Overlapping adapters double-count/)
  })

  it('deploys the Worker without claiming a route and prints the exact manual steps', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory: path.join(scratch(), 'worker'),
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
      confirmFailOpen: true,
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
      preflightWrangler: async () => {},
      deployWorker: async () => {},
    })

    const stdout = logs.join('\n')
    expect(stdout).toContain('Worker deployed; route not attached')
    expect(stdout).toContain('Attach `example.com/*` manually')
    expect(stdout).toContain('Request limit failure mode to Fail open before activation')
  })

  it('writes artifacts but refuses auto-deploy when the CLI cannot read server credentials', async () => {
    const outputDirectory = path.join(scratch(), 'worker')
    let deployCalled = false
    let thrown: unknown

    try {
      await trafficConnectCloudflare('demo', {
        outputDirectory,
        zoneId: 'zone_test',
        deploy: true,
        confirmRoute: true,
        confirmFailOpen: true,
      }, {
        client: { trafficConnectCloudflare: async () => response },
        loadLocalConfig: () => null,
        preflightWrangler: async () => {},
        deployWorker: async () => { deployCalled = true },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe('TRAFFIC_CLOUDFLARE_DEPLOY_CONFIG_UNSHARED')
    expect((thrown as CliError).displayMessage).toMatch(/server operator/i)
    expect(deployCalled).toBe(false)
    expect(fs.existsSync(path.join(outputDirectory, 'worker.js'))).toBe(true)
    expect(fs.existsSync(path.join(outputDirectory, 'wrangler.toml'))).toBe(true)
  })
})

describe('trafficActivate', () => {
  it('activates the exact source and renders its delivery, status, and schedule implication', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))
    let calledWith: [string, string] | undefined

    await trafficActivate('demo', {
      sourceId: activatedQueueSource.id,
    }, {
      client: {
        trafficActivate: async (project, sourceId) => {
          calledWith = [project, sourceId]
          return activatedQueueSource
        },
      },
    })

    expect(calledWith).toEqual(['demo', activatedQueueSource.id])
    expect(logs.join('\n')).toContain('Source mode:     queue-pull')
    expect(logs.join('\n')).toContain('Status:          connected')
    expect(logs.join('\n')).toContain('Traffic sync:    enabled for this pull source')
  })

  it('emits the unmodified activated source DTO in machine format', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficActivate('demo', {
      sourceId: activatedQueueSource.id,
      format: 'json',
    }, {
      client: { trafficActivate: async () => activatedQueueSource },
    })

    expect(JSON.parse(logs.join('\n'))).toEqual(activatedQueueSource)
  })

  it('reports that direct-push activation needs no polling schedule', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))
    await trafficActivate('demo', {
      sourceId: 'source-direct',
    }, {
      client: {
        trafficActivate: async () => ({
          ...activatedQueueSource,
          id: 'source-direct',
          config: { deliveryMode: 'direct-push' },
        }),
      },
    })

    expect(logs.join('\n')).toContain('Traffic sync:    not required for direct-push delivery')
  })

  it('renders non-Cloudflare pull adapters without inventing a delivery mode', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))
    await trafficActivate('demo', {
      sourceId: 'source-cloud-run',
    }, {
      client: {
        trafficActivate: async () => ({
          ...activatedQueueSource,
          id: 'source-cloud-run',
          sourceType: 'cloud-run',
          displayName: 'Cloud Run',
          config: { gcpProjectId: 'project-1' },
        }),
      },
    })

    expect(logs.join('\n')).toContain('Traffic source activated for project "demo".')
    expect(logs.join('\n')).toContain('Source mode:     cloud-run')
    expect(logs.join('\n')).toContain('Traffic sync:    enabled for this pull source')
  })
})
