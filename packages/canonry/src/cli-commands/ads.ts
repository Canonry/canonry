import {
  adsConnect,
  adsDisconnect,
  adsStatus,
  adsAccount,
  adsGeoSearch,
  adsConversionPixels,
  adsConversionEventSettings,
  adsSync,
  adsCampaigns,
  adsInsights,
  adsSummary,
  adsOperationGet,
  adsOperationReconcile,
  adsOperationResumeActivation,
  adsOperationsUnresolved,
  adsActivationGrantCreate,
  adsActivationGrantRevoke,
  adsImageUpload,
  adsCampaignCreate,
  adsCampaignUpdate,
  adsCampaignActivateTree,
  adsCampaignPause,
  adsAdGroupCreate,
  adsAdGroupUpdate,
  adsAdGroupPause,
  adsAdCreate,
  adsAdUpdate,
  adsAdPause,
} from '../commands/ads.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { usageError } from '../cli-error.js'
import {
  getString,
  parseIntegerOption,
  requirePositional,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'

export const ADS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['ads', 'connect'],
    usage: 'canonry ads connect <project> --api-key <sdk-key> [--format json]',
    options: {
      'api-key': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ads.connect', 'canonry ads connect <project> --api-key <sdk-key> [--format json]')
      await adsConnect(project, {
        apiKey: getString(input.values, 'api-key'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'disconnect'],
    usage: 'canonry ads disconnect <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.disconnect', 'canonry ads disconnect <project> [--format json]')
      await adsDisconnect(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'status'],
    usage: 'canonry ads status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.status', 'canonry ads status <project> [--format json]')
      await adsStatus(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'account'],
    usage: 'canonry ads account <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.account', 'canonry ads account <project> [--format json]')
      await adsAccount(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'geo', 'search'],
    usage: 'canonry ads geo search <project> --query <text> [--limit <n>] [--format json|jsonl]',
    options: {
      query: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry ads geo search <project> --query <text> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'ads.geo.search', usage)
      await adsGeoSearch(project, {
        q: getString(input.values, 'query'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'ads.geo.search',
          message: '--limit must be an integer from 1 to 100',
          usage,
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'conversions', 'pixels'],
    usage: 'canonry ads conversions pixels <project> [--format json|jsonl]',
    run: async (input) => {
      const project = requireProject(input, 'ads.conversions.pixels', 'canonry ads conversions pixels <project> [--format json|jsonl]')
      await adsConversionPixels(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'conversions', 'event-settings'],
    usage: 'canonry ads conversions event-settings <project> [--format json|jsonl]',
    run: async (input) => {
      const project = requireProject(input, 'ads.conversions.event-settings', 'canonry ads conversions event-settings <project> [--format json|jsonl]')
      await adsConversionEventSettings(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'operations', 'unresolved'],
    usage: 'canonry ads operations unresolved <project> [--state <csv>] [--limit <n>] [--cursor <opaque>] [--format json|jsonl]',
    options: {
      state: stringOption(),
      limit: stringOption(),
      cursor: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry ads operations unresolved <project> [--state <csv>] [--limit <n>] [--cursor <opaque>] [--format json|jsonl]'
      const project = requireProject(
        input,
        'ads.operations.unresolved',
        usage,
      )
      const rawState = getString(input.values, 'state')
      const state = rawState === undefined
        ? undefined
        : rawState.split(',').filter((value): value is 'pending' | 'unknown' | 'reconciling' => (
            value === 'pending' || value === 'unknown' || value === 'reconciling'
          ))
      if (rawState !== undefined && state?.length !== rawState.split(',').length) {
        throw usageError(`Error: --state must contain only pending, unknown, or reconciling\nUsage: ${usage}`, {
          message: '--state must contain only pending, unknown, or reconciling',
          details: { command: 'ads.operations.unresolved', usage },
        })
      }
      await adsOperationsUnresolved(project, {
        state,
        limit: parseIntegerOption(input, 'limit', {
          command: 'ads.operations.unresolved',
          message: '--limit must be an integer from 1 to 200',
          usage,
        }),
        cursor: getString(input.values, 'cursor'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'operation'],
    usage: 'canonry ads operation <project> <operation-key> [--format json]',
    run: async (input) => {
      const usage = 'canonry ads operation <project> <operation-key> [--format json]'
      const project = requireProject(input, 'ads.operation', usage)
      const operationKey = requirePositional(input, 1, {
        command: 'ads.operation', usage, message: 'operation key is required',
      })
      await adsOperationGet(project, { operationKey, format: input.format })
    },
  },
  {
    path: ['ads', 'operation', 'reconcile'],
    usage: 'canonry ads operation reconcile <project> --operation-key <key> [--format json]',
    options: {
      'operation-key': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry ads operation reconcile <project> --operation-key <key> [--format json]'
      const project = requireProject(input, 'ads.operation.reconcile', usage)
      const operationKey = requireStringOption(input, 'operation-key', {
        command: 'ads.operation.reconcile',
        usage,
        message: '--operation-key is required',
      })
      await adsOperationReconcile(project, {
        operationKey,
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'operation', 'resume-activation'],
    usage: 'canonry ads operation resume-activation <project> --operation-key <key> [--format json]',
    options: { 'operation-key': stringOption() },
    run: async (input) => {
      const usage = 'canonry ads operation resume-activation <project> --operation-key <key> [--format json]'
      const project = requireProject(input, 'ads.operation.resume-activation', usage)
      await adsOperationResumeActivation(project, {
        operationKey: requireStringOption(input, 'operation-key', {
          command: 'ads.operation.resume-activation',
          message: '--operation-key is required',
          usage,
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'activation-grant', 'create'],
    usage: 'canonry ads activation-grant create <project> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads activation-grant create <project> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.activation-grant.create', usage)
      await adsActivationGrantCreate(project, {
        input: getString(input.values, 'input'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'activation-grant', 'revoke'],
    usage: 'canonry ads activation-grant revoke <project> <grant-id> [--format json]',
    run: async (input) => {
      const usage = 'canonry ads activation-grant revoke <project> <grant-id> [--format json]'
      const project = requireProject(input, 'ads.activation-grant.revoke', usage)
      const grantId = requirePositional(input, 1, {
        command: 'ads.activation-grant.revoke',
        usage,
        message: 'activation grant id is required',
      })
      await adsActivationGrantRevoke(project, grantId, { format: input.format })
    },
  },
  {
    path: ['ads', 'image', 'upload'],
    usage: 'canonry ads image upload <project> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'ads.image.upload', 'canonry ads image upload <project> --input <json-file|-> [--format json]')
      await adsImageUpload(project, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'campaign', 'create'],
    usage: 'canonry ads campaign create <project> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'ads.campaign.create', 'canonry ads campaign create <project> --input <json-file|-> [--format json]')
      await adsCampaignCreate(project, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'campaign', 'update'],
    usage: 'canonry ads campaign update <project> <campaign-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads campaign update <project> <campaign-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.campaign.update', usage)
      const id = requirePositional(input, 1, { command: 'ads.campaign.update', usage, message: 'campaign id is required' })
      await adsCampaignUpdate(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'campaign', 'activate-tree'],
    usage: 'canonry ads campaign activate-tree <project> <campaign-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads campaign activate-tree <project> <campaign-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.campaign.activate-tree', usage)
      const id = requirePositional(input, 1, {
        command: 'ads.campaign.activate-tree',
        usage,
        message: 'campaign id is required',
      })
      await adsCampaignActivateTree(project, id, {
        input: getString(input.values, 'input'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'campaign', 'pause'],
    usage: 'canonry ads campaign pause <project> <campaign-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads campaign pause <project> <campaign-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.campaign.pause', usage)
      const id = requirePositional(input, 1, { command: 'ads.campaign.pause', usage, message: 'campaign id is required' })
      await adsCampaignPause(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad-group', 'create'],
    usage: 'canonry ads ad-group create <project> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'ads.ad-group.create', 'canonry ads ad-group create <project> --input <json-file|-> [--format json]')
      await adsAdGroupCreate(project, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad-group', 'update'],
    usage: 'canonry ads ad-group update <project> <ad-group-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads ad-group update <project> <ad-group-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.ad-group.update', usage)
      const id = requirePositional(input, 1, { command: 'ads.ad-group.update', usage, message: 'ad group id is required' })
      await adsAdGroupUpdate(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad-group', 'pause'],
    usage: 'canonry ads ad-group pause <project> <ad-group-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads ad-group pause <project> <ad-group-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.ad-group.pause', usage)
      const id = requirePositional(input, 1, { command: 'ads.ad-group.pause', usage, message: 'ad group id is required' })
      await adsAdGroupPause(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad', 'create'],
    usage: 'canonry ads ad create <project> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'ads.ad.create', 'canonry ads ad create <project> --input <json-file|-> [--format json]')
      await adsAdCreate(project, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad', 'update'],
    usage: 'canonry ads ad update <project> <ad-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads ad update <project> <ad-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.ad.update', usage)
      const id = requirePositional(input, 1, { command: 'ads.ad.update', usage, message: 'ad id is required' })
      await adsAdUpdate(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'ad', 'pause'],
    usage: 'canonry ads ad pause <project> <ad-id> --input <json-file|-> [--format json]',
    options: { input: stringOption() },
    run: async (input) => {
      const usage = 'canonry ads ad pause <project> <ad-id> --input <json-file|-> [--format json]'
      const project = requireProject(input, 'ads.ad.pause', usage)
      const id = requirePositional(input, 1, { command: 'ads.ad.pause', usage, message: 'ad id is required' })
      await adsAdPause(project, id, { input: getString(input.values, 'input'), format: input.format })
    },
  },
  {
    path: ['ads', 'sync'],
    usage: 'canonry ads sync <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.sync', 'canonry ads sync <project> [--format json]')
      await adsSync(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'campaigns'],
    usage: 'canonry ads campaigns <project> [--format json|jsonl]',
    run: async (input) => {
      const project = requireProject(input, 'ads.campaigns', 'canonry ads campaigns <project> [--format json|jsonl]')
      await adsCampaigns(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'insights'],
    usage: 'canonry ads insights <project> [--level campaign|ad_group] [--entity <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format json|jsonl]',
    options: {
      level: stringOption(),
      entity: stringOption(),
      from: stringOption(),
      to: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ads.insights', 'canonry ads insights <project> [--level <level>] [--entity <id>] [--from <date>] [--to <date>] [--format json|jsonl]')
      await adsInsights(project, {
        level: getString(input.values, 'level'),
        entity: getString(input.values, 'entity'),
        from: getString(input.values, 'from'),
        to: getString(input.values, 'to'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'summary'],
    usage: 'canonry ads summary <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.summary', 'canonry ads summary <project> [--format json]')
      await adsSummary(project, { format: input.format })
    },
  },
]
