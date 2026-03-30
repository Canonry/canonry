import fs from 'node:fs'
import type { WordpressEnv } from '@ainyc/canonry-contracts'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requirePositional, requireProject, requireStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import {
  wordpressAudit,
  wordpressBulkSetMeta,
  wordpressConnect,
  wordpressCreatePage,
  wordpressDiff,
  wordpressDisconnect,
  wordpressLlmsTxt,
  wordpressOnboard,
  wordpressPage,
  wordpressPages,
  wordpressSchema,
  wordpressSchemaDeploy,
  wordpressSchemaStatus,
  wordpressSetLlmsTxt,
  wordpressSetMeta,
  wordpressSetSchema,
  wordpressStagingPush,
  wordpressStagingStatus,
  wordpressStatus,
  wordpressUpdatePage,
} from '../commands/wordpress.js'

function resolveEnv(input: CliCommandInput, command: string, usage: string): WordpressEnv | undefined {
  const live = getBoolean(input.values, 'live')
  const staging = getBoolean(input.values, 'staging')
  if (live && staging) {
    throw usageError('Error: choose only one of --live or --staging', {
      message: 'choose only one of --live or --staging',
      details: { command, usage },
    })
  }
  if (live) return 'live'
  if (staging) return 'staging'
  return undefined
}

function resolveNoindex(input: CliCommandInput, command: string, usage: string): boolean | undefined {
  const noindex = getBoolean(input.values, 'noindex')
  const index = getBoolean(input.values, 'index')
  if (noindex && index) {
    throw usageError('Error: choose only one of --noindex or --index', {
      message: 'choose only one of --noindex or --index',
      details: { command, usage },
    })
  }
  if (noindex) return true
  if (index) return false
  return undefined
}

function resolveContent(
  input: CliCommandInput,
  command: string,
  usage: string,
  options?: { required?: boolean },
): string | undefined {
  const content = getString(input.values, 'content')
  const contentFile = getString(input.values, 'content-file')

  if (content && contentFile) {
    throw usageError('Error: choose only one of --content or --content-file', {
      message: 'choose only one of --content or --content-file',
      details: { command, usage },
    })
  }

  if (contentFile) {
    try {
      return fs.readFileSync(contentFile, 'utf-8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw usageError(`Error: could not read --content-file "${contentFile}": ${message}`, {
        message: `could not read --content-file "${contentFile}": ${message}`,
        details: { command, usage },
      })
    }
  }

  if (content != null) return content
  if (!options?.required) return undefined

  throw usageError('Error: one of --content or --content-file is required', {
    message: 'one of --content or --content-file is required',
    details: { command, usage },
  })
}

const envOptions = {
  live: { type: 'boolean', default: false },
  staging: { type: 'boolean', default: false },
} as const

export const WORDPRESS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['wordpress', 'connect'],
    usage: 'canonry wordpress connect <project> --url <url> --user <user> [--app-password <password>] [--staging-url <url>] [--default-env live|staging] [--format json]',
    options: {
      url: stringOption(),
      user: stringOption(),
      'app-password': stringOption(),
      'staging-url': stringOption(),
      'default-env': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry wordpress connect <project> --url <url> --user <user> [--app-password <password>] [--staging-url <url>] [--default-env live|staging] [--format json]'
      const project = requireProject(input, 'wordpress.connect', usage)
      const url = requireStringOption(input, 'url', {
        command: 'wordpress.connect',
        usage,
        message: '--url is required',
      })
      const user = requireStringOption(input, 'user', {
        command: 'wordpress.connect',
        usage,
        message: '--user is required',
      })
      const defaultEnvValue = getString(input.values, 'default-env')
      if (defaultEnvValue && defaultEnvValue !== 'live' && defaultEnvValue !== 'staging') {
        throw usageError('Error: --default-env must be live or staging', {
          message: '--default-env must be live or staging',
          details: { command: 'wordpress.connect', usage },
        })
      }
      await wordpressConnect(project, {
        url,
        user,
        appPassword: getString(input.values, 'app-password'),
        stagingUrl: getString(input.values, 'staging-url'),
        defaultEnv: defaultEnvValue as WordpressEnv | undefined,
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'disconnect'],
    usage: 'canonry wordpress disconnect <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'wordpress.disconnect', 'canonry wordpress disconnect <project> [--format json]')
      await wordpressDisconnect(project, input.format)
    },
  },
  {
    path: ['wordpress', 'status'],
    usage: 'canonry wordpress status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'wordpress.status', 'canonry wordpress status <project> [--format json]')
      await wordpressStatus(project, input.format)
    },
  },
  {
    path: ['wordpress', 'pages'],
    usage: 'canonry wordpress pages <project> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress pages <project> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.pages', usage)
      await wordpressPages(project, {
        env: resolveEnv(input, 'wordpress.pages', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'page'],
    usage: 'canonry wordpress page <project> <slug> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress page <project> <slug> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.page', usage)
      const slug = requirePositional(input, 1, {
        command: 'wordpress.page',
        usage,
        message: 'project name and slug are required',
      })
      await wordpressPage(project, slug, {
        env: resolveEnv(input, 'wordpress.page', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'create-page'],
    usage: 'canonry wordpress create-page <project> --title <title> --slug <slug> [--content <content>|--content-file <path>] [--status draft|publish] [--live|--staging] [--format json]',
    options: {
      title: stringOption(),
      slug: stringOption(),
      content: stringOption(),
      'content-file': stringOption(),
      status: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress create-page <project> --title <title> --slug <slug> [--content <content>|--content-file <path>] [--status draft|publish] [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.create-page', usage)
      await wordpressCreatePage(project, {
        title: requireStringOption(input, 'title', {
          command: 'wordpress.create-page',
          usage,
          message: '--title is required',
        }),
        slug: requireStringOption(input, 'slug', {
          command: 'wordpress.create-page',
          usage,
          message: '--slug is required',
        }),
        content: resolveContent(input, 'wordpress.create-page', usage, { required: true })!,
        status: getString(input.values, 'status'),
        env: resolveEnv(input, 'wordpress.create-page', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'update-page'],
    usage: 'canonry wordpress update-page <project> <slug> [--title <title>] [--slug <slug>] [--content <content>|--content-file <path>] [--status draft|publish] [--live|--staging] [--format json]',
    options: {
      title: stringOption(),
      slug: stringOption(),
      content: stringOption(),
      'content-file': stringOption(),
      status: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress update-page <project> <slug> [--title <title>] [--slug <slug>] [--content <content>|--content-file <path>] [--status draft|publish] [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.update-page', usage)
      const currentSlug = requirePositional(input, 1, {
        command: 'wordpress.update-page',
        usage,
        message: 'project name and current slug are required',
      })
      await wordpressUpdatePage(project, {
        currentSlug,
        title: getString(input.values, 'title'),
        slug: getString(input.values, 'slug'),
        content: resolveContent(input, 'wordpress.update-page', usage),
        status: getString(input.values, 'status'),
        env: resolveEnv(input, 'wordpress.update-page', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'set-meta'],
    usage: 'canonry wordpress set-meta <project> <slug> [--title <title>] [--description <text>] [--noindex|--index] [--from <file>] [--live|--staging] [--format json]',
    options: {
      title: stringOption(),
      description: stringOption(),
      noindex: { type: 'boolean', default: false },
      index: { type: 'boolean', default: false },
      from: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const fromFile = getString(input.values, 'from')
      if (fromFile) {
        const usage = 'canonry wordpress set-meta <project> --from <file> [--live|--staging] [--format json]'
        const project = requireProject(input, 'wordpress.set-meta', usage)
        await wordpressBulkSetMeta(project, {
          from: fromFile,
          env: resolveEnv(input, 'wordpress.set-meta', usage),
          format: input.format,
        })
        return
      }
      const usage = 'canonry wordpress set-meta <project> <slug> [--title <title>] [--description <text>] [--noindex|--index] [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.set-meta', usage)
      const slug = requirePositional(input, 1, {
        command: 'wordpress.set-meta',
        usage,
        message: 'project name and slug are required',
      })
      await wordpressSetMeta(project, {
        slug,
        title: getString(input.values, 'title'),
        description: getString(input.values, 'description'),
        noindex: resolveNoindex(input, 'wordpress.set-meta', usage),
        env: resolveEnv(input, 'wordpress.set-meta', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'schema', 'deploy'],
    usage: 'canonry wordpress schema deploy <project> --profile <file> [--live|--staging] [--format json]',
    options: {
      profile: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress schema deploy <project> --profile <file> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.schema.deploy', usage)
      const profile = requireStringOption(input, 'profile', {
        message: '--profile is required',
        command: 'wordpress.schema.deploy',
        usage,
      })
      await wordpressSchemaDeploy(project, {
        profile,
        env: resolveEnv(input, 'wordpress.schema.deploy', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'schema', 'status'],
    usage: 'canonry wordpress schema status <project> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress schema status <project> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.schema.status', usage)
      await wordpressSchemaStatus(project, {
        env: resolveEnv(input, 'wordpress.schema.status', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'schema'],
    usage: 'canonry wordpress schema <project> <slug> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress schema <project> <slug> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.schema', usage)
      const slug = requirePositional(input, 1, {
        command: 'wordpress.schema',
        usage,
        message: 'project name and slug are required',
      })
      await wordpressSchema(project, slug, {
        env: resolveEnv(input, 'wordpress.schema', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'set-schema'],
    usage: 'canonry wordpress set-schema <project> <slug> --json <json> [--type <type>] [--live|--staging] [--format json]',
    options: {
      json: stringOption(),
      type: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress set-schema <project> <slug> --json <json> [--type <type>] [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.set-schema', usage)
      const slug = requirePositional(input, 1, {
        command: 'wordpress.set-schema',
        usage,
        message: 'project name and slug are required',
      })
      await wordpressSetSchema(project, {
        slug,
        type: getString(input.values, 'type'),
        json: requireStringOption(input, 'json', {
          command: 'wordpress.set-schema',
          usage,
          message: '--json is required',
        }),
        env: resolveEnv(input, 'wordpress.set-schema', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'llms-txt'],
    usage: 'canonry wordpress llms-txt <project> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress llms-txt <project> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.llms-txt', usage)
      await wordpressLlmsTxt(project, {
        env: resolveEnv(input, 'wordpress.llms-txt', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'set-llms-txt'],
    usage: 'canonry wordpress set-llms-txt <project> --content <content> [--live|--staging] [--format json]',
    options: {
      content: stringOption(),
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress set-llms-txt <project> --content <content> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.set-llms-txt', usage)
      await wordpressSetLlmsTxt(project, {
        content: requireStringOption(input, 'content', {
          command: 'wordpress.set-llms-txt',
          usage,
          message: '--content is required',
        }),
        env: resolveEnv(input, 'wordpress.set-llms-txt', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'onboard'],
    usage: 'canonry wordpress onboard <project> --url <url> --user <user> [--app-password <pw>] [--profile <file>] [--skip-schema] [--skip-submit] [--live|--staging] [--format json]',
    options: {
      url: stringOption(),
      user: stringOption(),
      'app-password': stringOption(),
      'staging-url': stringOption(),
      profile: stringOption(),
      'skip-schema': { type: 'boolean', default: false },
      'skip-submit': { type: 'boolean', default: false },
      ...envOptions,
    },
    run: async (input) => {
      const usage = 'canonry wordpress onboard <project> --url <url> --user <user> [--app-password <pw>] [--profile <file>] [--format json]'
      const project = requireProject(input, 'wordpress.onboard', usage)
      const url = requireStringOption(input, 'url', {
        message: '--url is required',
        command: 'wordpress.onboard',
        usage,
      })
      const user = requireStringOption(input, 'user', {
        message: '--user is required',
        command: 'wordpress.onboard',
        usage,
      })
      await wordpressOnboard(project, {
        url,
        user,
        appPassword: getString(input.values, 'app-password'),
        stagingUrl: getString(input.values, 'staging-url'),
        defaultEnv: resolveEnv(input, 'wordpress.onboard', usage),
        profile: getString(input.values, 'profile'),
        skipSchema: getBoolean(input.values, 'skip-schema'),
        skipSubmit: getBoolean(input.values, 'skip-submit'),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'audit'],
    usage: 'canonry wordpress audit <project> [--live|--staging] [--format json]',
    options: envOptions,
    run: async (input) => {
      const usage = 'canonry wordpress audit <project> [--live|--staging] [--format json]'
      const project = requireProject(input, 'wordpress.audit', usage)
      await wordpressAudit(project, {
        env: resolveEnv(input, 'wordpress.audit', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['wordpress', 'diff'],
    usage: 'canonry wordpress diff <project> <slug> [--format json]',
    run: async (input) => {
      const usage = 'canonry wordpress diff <project> <slug> [--format json]'
      const project = requireProject(input, 'wordpress.diff', usage)
      const slug = requirePositional(input, 1, {
        command: 'wordpress.diff',
        usage,
        message: 'project name and slug are required',
      })
      await wordpressDiff(project, slug, input.format)
    },
  },
  {
    path: ['wordpress', 'staging', 'status'],
    usage: 'canonry wordpress staging status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'wordpress.staging.status', 'canonry wordpress staging status <project> [--format json]')
      await wordpressStagingStatus(project, input.format)
    },
  },
  {
    path: ['wordpress', 'staging', 'push'],
    usage: 'canonry wordpress staging push <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'wordpress.staging.push', 'canonry wordpress staging push <project> [--format json]')
      await wordpressStagingPush(project, input.format)
    },
  },
  {
    path: ['wordpress', 'staging'],
    usage: 'canonry wordpress staging <status|push> <project> [--format json]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'wordpress staging',
        usage: 'canonry wordpress staging <status|push> <project> [--format json]',
        available: ['status', 'push'],
      })
    },
  },
  {
    path: ['wordpress'],
    usage: 'canonry wordpress <connect|disconnect|status|pages|page|create-page|update-page|set-meta|schema|set-schema|llms-txt|set-llms-txt|audit|diff|staging> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'wordpress',
        usage: 'canonry wordpress <connect|disconnect|status|pages|page|create-page|update-page|set-meta|schema|set-schema|llms-txt|set-llms-txt|audit|diff|staging> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'pages', 'page', 'create-page', 'update-page', 'set-meta', 'schema', 'set-schema', 'llms-txt', 'set-llms-txt', 'audit', 'diff', 'staging'],
      })
    },
  },
]
