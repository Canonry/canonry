import { WINDOW_SETS, parseWindowIn, AppError } from '@ainyc/canonry-contracts'
import { type GoogleAdsMetricsWindow } from '@ainyc/canonry-contracts'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getString,
  parseIntegerOption,
  requirePositional,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import {
  conversionTrackingContract,
  conversionTrackingContracts,
  conversionTrackingCreate,
  conversionTrackingDelete,
  conversionTrackingIntegrity,
  conversionTrackingUpdate,
  googleAdsCustomers,
  googleAdsDisconnect,
  googleAdsPerformance,
  googleAdsSelect,
  googleAdsSnapshot,
  googleAdsSnapshots,
  googleAdsStatus,
  googleAdsSync,
  gtmAccounts,
  gtmContainers,
  gtmDisconnect,
  gtmSelect,
  gtmSnapshot,
  gtmSnapshots,
  gtmStatus,
  gtmSync,
  gtmWorkspaces,
  readConversionTrackingContractInput,
  type GoogleMarketingCliClient,
} from '../commands/google-marketing.js'

function snapshotLimit(
  input: Parameters<CliCommandSpec['run']>[0],
  command: string,
  usage: string,
): number | undefined {
  const limit = parseIntegerOption(input, 'limit', {
    command,
    usage,
    message: '--limit must be an integer from 1 to 100',
  })
  if (limit !== undefined && (limit < 1 || limit > 100)) {
    throw usageError(`Error: --limit must be an integer from 1 to 100\nUsage: ${usage}`, {
      message: '--limit must be an integer from 1 to 100',
      details: { command, usage, option: 'limit', value: limit },
    })
  }
  return limit
}

/**
 * Only the windows the STORED snapshot can serve are accepted. A 30d or 90d
 * option would promise a period the 31-day snapshot cannot cover, and the parser
 * refusing it locally is a clearer answer than a 400 from the API.
 */
function performanceWindow(
  input: Parameters<CliCommandSpec['run']>[0],
  usage: string,
): GoogleAdsMetricsWindow | undefined {
  const raw = getString(input.values, 'window')
  if (raw === undefined) return undefined
  try { return parseWindowIn(raw, WINDOW_SETS.googleAdsMetrics, { fallback: '14d' }) }
  catch (error) {
    if (error instanceof AppError) throw usageError(error.message, { details: { ...error.details, command: 'google-ads.performance', usage } })
    throw error
  }
}

/**
 * Parser-only factory. It receives the SDK-backed ApiClient at registration
 * time, keeping this definition independently testable while OpenAPI codegen
 * supplies the actual transport implementation.
 */
export function createGoogleMarketingCliCommands(
  createClient: () => GoogleMarketingCliClient,
): readonly CliCommandSpec[] {
  return [
    {
      path: ['google-ads', 'disconnect'],
      usage: 'canonry google-ads disconnect <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry google-ads disconnect <project> [--format json]'
        await googleAdsDisconnect(createClient(), requireProject(input, 'google-ads.disconnect', usage), { format: input.format })
      },
    },
    {
      path: ['google-ads', 'status'],
      usage: 'canonry google-ads status <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry google-ads status <project> [--format json]'
        await googleAdsStatus(createClient(), requireProject(input, 'google-ads.status', usage), { format: input.format })
      },
    },
    {
      path: ['google-ads', 'customers'],
      usage: 'canonry google-ads customers <project> [--format json|jsonl]',
      run: async (input) => {
        const usage = 'canonry google-ads customers <project> [--format json|jsonl]'
        await googleAdsCustomers(createClient(), requireProject(input, 'google-ads.customers', usage), { format: input.format })
      },
    },
    {
      path: ['google-ads', 'select'],
      usage: 'canonry google-ads select <project> --customer <customer-id> [--login-customer <manager-id>] [--format json]',
      options: { customer: stringOption(), 'login-customer': stringOption() },
      run: async (input) => {
        const usage = 'canonry google-ads select <project> --customer <customer-id> [--login-customer <manager-id>] [--format json]'
        const project = requireProject(input, 'google-ads.select', usage)
        const customerId = requireStringOption(input, 'customer', {
          command: 'google-ads.select', usage, message: '--customer is required',
        })
        await googleAdsSelect(createClient(), project, {
          customerId,
          ...(getString(input.values, 'login-customer') ? { loginCustomerId: getString(input.values, 'login-customer') } : {}),
        }, { format: input.format })
      },
    },
    {
      path: ['google-ads', 'sync'],
      usage: 'canonry google-ads sync <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry google-ads sync <project> [--format json]'
        await googleAdsSync(createClient(), requireProject(input, 'google-ads.sync', usage), { format: input.format })
      },
    },
    {
      path: ['google-ads', 'performance'],
      windows: WINDOW_SETS.googleAdsMetrics,
      usage: 'canonry google-ads performance <project> [--window 7d|14d|30d] [--format json]',
      options: { window: stringOption() },
      run: async (input) => {
        const usage = 'canonry google-ads performance <project> [--window 7d|14d|30d] [--format json]'
        const project = requireProject(input, 'google-ads.performance', usage)
        const window = performanceWindow(input, usage)
        await googleAdsPerformance(createClient(), project, {
          ...(window ? { window } : {}),
          format: input.format,
        })
      },
    },
    {
      path: ['google-ads', 'snapshots'],
      usage: 'canonry google-ads snapshots <project> [--limit <n>] [--cursor <opaque>] [--format json|jsonl]',
      options: { limit: stringOption(), cursor: stringOption() },
      run: async (input) => {
        const usage = 'canonry google-ads snapshots <project> [--limit <n>] [--cursor <opaque>] [--format json|jsonl]'
        await googleAdsSnapshots(createClient(), requireProject(input, 'google-ads.snapshots', usage), {
          limit: snapshotLimit(input, 'google-ads.snapshots', usage),
          cursor: getString(input.values, 'cursor'),
          format: input.format,
        })
      },
    },
    {
      path: ['google-ads', 'snapshot'],
      usage: 'canonry google-ads snapshot <project> <snapshot-id> [--format json]',
      run: async (input) => {
        const usage = 'canonry google-ads snapshot <project> <snapshot-id> [--format json]'
        const project = requireProject(input, 'google-ads.snapshot', usage)
        await googleAdsSnapshot(createClient(), project, requirePositional(input, 1, {
          command: 'google-ads.snapshot', usage, message: 'snapshot id is required',
        }), { format: input.format })
      },
    },
    {
      path: ['gtm', 'disconnect'],
      usage: 'canonry gtm disconnect <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry gtm disconnect <project> [--format json]'
        await gtmDisconnect(createClient(), requireProject(input, 'gtm.disconnect', usage), { format: input.format })
      },
    },
    {
      path: ['gtm', 'status'],
      usage: 'canonry gtm status <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry gtm status <project> [--format json]'
        await gtmStatus(createClient(), requireProject(input, 'gtm.status', usage), { format: input.format })
      },
    },
    {
      path: ['gtm', 'accounts'],
      usage: 'canonry gtm accounts <project> [--format json|jsonl]',
      run: async (input) => {
        const usage = 'canonry gtm accounts <project> [--format json|jsonl]'
        await gtmAccounts(createClient(), requireProject(input, 'gtm.accounts', usage), { format: input.format })
      },
    },
    {
      path: ['gtm', 'containers'],
      usage: 'canonry gtm containers <project> --account <account-id> [--format json|jsonl]',
      options: { account: stringOption() },
      run: async (input) => {
        const usage = 'canonry gtm containers <project> --account <account-id> [--format json|jsonl]'
        const project = requireProject(input, 'gtm.containers', usage)
        await gtmContainers(createClient(), project, requireStringOption(input, 'account', {
          command: 'gtm.containers', usage, message: '--account is required',
        }), { format: input.format })
      },
    },
    {
      path: ['gtm', 'workspaces'],
      usage: 'canonry gtm workspaces <project> --account <account-id> --container <container-id> [--format json|jsonl]',
      options: { account: stringOption(), container: stringOption() },
      run: async (input) => {
        const usage = 'canonry gtm workspaces <project> --account <account-id> --container <container-id> [--format json|jsonl]'
        const project = requireProject(input, 'gtm.workspaces', usage)
        const accountId = requireStringOption(input, 'account', { command: 'gtm.workspaces', usage, message: '--account is required' })
        const containerId = requireStringOption(input, 'container', { command: 'gtm.workspaces', usage, message: '--container is required' })
        await gtmWorkspaces(createClient(), project, accountId, containerId, { format: input.format })
      },
    },
    {
      path: ['gtm', 'select'],
      usage: 'canonry gtm select <project> --account <account-id> --container <container-id> [--workspace <workspace-id>] [--format json]',
      options: { account: stringOption(), container: stringOption(), workspace: stringOption() },
      run: async (input) => {
        const usage = 'canonry gtm select <project> --account <account-id> --container <container-id> [--workspace <workspace-id>] [--format json]'
        const project = requireProject(input, 'gtm.select', usage)
        const accountId = requireStringOption(input, 'account', { command: 'gtm.select', usage, message: '--account is required' })
        const containerId = requireStringOption(input, 'container', { command: 'gtm.select', usage, message: '--container is required' })
        const workspaceId = getString(input.values, 'workspace')
        await gtmSelect(createClient(), project, {
          accountId,
          containerId,
          ...(workspaceId ? { workspaceId } : {}),
        }, { format: input.format })
      },
    },
    {
      path: ['gtm', 'sync'],
      usage: 'canonry gtm sync <project> [--format json]',
      run: async (input) => {
        const usage = 'canonry gtm sync <project> [--format json]'
        await gtmSync(createClient(), requireProject(input, 'gtm.sync', usage), { format: input.format })
      },
    },
    {
      path: ['gtm', 'snapshots'],
      usage: 'canonry gtm snapshots <project> [--limit <n>] [--cursor <opaque>] [--format json|jsonl]',
      options: { limit: stringOption(), cursor: stringOption() },
      run: async (input) => {
        const usage = 'canonry gtm snapshots <project> [--limit <n>] [--cursor <opaque>] [--format json|jsonl]'
        await gtmSnapshots(createClient(), requireProject(input, 'gtm.snapshots', usage), {
          limit: snapshotLimit(input, 'gtm.snapshots', usage),
          cursor: getString(input.values, 'cursor'),
          format: input.format,
        })
      },
    },
    {
      path: ['gtm', 'snapshot'],
      usage: 'canonry gtm snapshot <project> <snapshot-id> [--format json]',
      run: async (input) => {
        const usage = 'canonry gtm snapshot <project> <snapshot-id> [--format json]'
        const project = requireProject(input, 'gtm.snapshot', usage)
        await gtmSnapshot(createClient(), project, requirePositional(input, 1, {
          command: 'gtm.snapshot', usage, message: 'snapshot id is required',
        }), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts'],
      usage: 'canonry conversion-tracking contracts <project> [--format json|jsonl]',
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts <project> [--format json|jsonl]'
        await conversionTrackingContracts(createClient(), requireProject(input, 'conversion-tracking.contracts', usage), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts', 'get'],
      usage: 'canonry conversion-tracking contracts get <project> <contract-id> [--format json]',
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts get <project> <contract-id> [--format json]'
        const project = requireProject(input, 'conversion-tracking.contracts.get', usage)
        await conversionTrackingContract(createClient(), project, requirePositional(input, 1, {
          command: 'conversion-tracking.contracts.get', usage, message: 'contract id is required',
        }), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts', 'create'],
      usage: 'canonry conversion-tracking contracts create <project> --input <json-file|-> [--format json]',
      options: { input: stringOption() },
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts create <project> --input <json-file|-> [--format json]'
        await conversionTrackingCreate(createClient(), requireProject(input, 'conversion-tracking.contracts.create', usage), readConversionTrackingContractInput(getString(input.values, 'input')), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts', 'update'],
      usage: 'canonry conversion-tracking contracts update <project> <contract-id> --input <json-file|-> [--format json]',
      options: { input: stringOption() },
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts update <project> <contract-id> --input <json-file|-> [--format json]'
        const project = requireProject(input, 'conversion-tracking.contracts.update', usage)
        const contractId = requirePositional(input, 1, { command: 'conversion-tracking.contracts.update', usage, message: 'contract id is required' })
        await conversionTrackingUpdate(createClient(), project, contractId, readConversionTrackingContractInput(getString(input.values, 'input')), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts', 'delete'],
      usage: 'canonry conversion-tracking contracts delete <project> <contract-id> [--format json]',
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts delete <project> <contract-id> [--format json]'
        const project = requireProject(input, 'conversion-tracking.contracts.delete', usage)
        await conversionTrackingDelete(createClient(), project, requirePositional(input, 1, {
          command: 'conversion-tracking.contracts.delete', usage, message: 'contract id is required',
        }), { format: input.format })
      },
    },
    {
      path: ['conversion-tracking', 'contracts', 'integrity'],
      usage: 'canonry conversion-tracking contracts integrity <project> <contract-id> [--format json|jsonl]',
      run: async (input) => {
        const usage = 'canonry conversion-tracking contracts integrity <project> <contract-id> [--format json|jsonl]'
        const project = requireProject(input, 'conversion-tracking.contracts.integrity', usage)
        await conversionTrackingIntegrity(createClient(), project, requirePositional(input, 1, {
          command: 'conversion-tracking.contracts.integrity', usage, message: 'contract id is required',
        }), { format: input.format })
      },
    },
  ]
}
