import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'

export const BACKLINKS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['backlinks', 'install'],
    usage: 'canonry backlinks install [--format json]',
    options: {},
    run: async (input) => {
      const { backlinksInstall } = await import('../commands/backlinks.js')
      await backlinksInstall({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'doctor'],
    usage: 'canonry backlinks doctor [--format json]',
    options: {},
    run: async (input) => {
      const { backlinksDoctor } = await import('../commands/backlinks.js')
      await backlinksDoctor({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'sync'],
    usage: 'canonry backlinks sync [--release <id>] [--wait] [--format json]',
    options: {
      release: stringOption(),
      wait: { type: 'boolean' },
    },
    run: async (input) => {
      const { backlinksSync } = await import('../commands/backlinks.js')
      await backlinksSync({
        release: getString(input.values, 'release'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['backlinks', 'status'],
    usage: 'canonry backlinks status [--format json]',
    options: {},
    run: async (input) => {
      const { backlinksStatus } = await import('../commands/backlinks.js')
      await backlinksStatus({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'list'],
    usage: 'canonry backlinks list <project> [--source commoncrawl|bing-webmaster] [--limit <n>] [--release <id>] [--exclude-crawlers] [--format json|jsonl]',
    options: {
      limit: stringOption(),
      release: stringOption(),
      source: stringOption(),
      'exclude-crawlers': { type: 'boolean' },
    },
    run: async (input) => {
      const { backlinksList, parseSourceFlag } = await import('../commands/backlinks.js')
      const project = requireProject(input, 'backlinks list',
        'canonry backlinks list <project> [--source commoncrawl|bing-webmaster] [--limit <n>] [--release <id>] [--exclude-crawlers]')
      const limit = parseIntegerOption(input, 'limit', {
        message: '--limit must be an integer',
        usage: 'canonry backlinks list <project> --limit <n>',
        command: 'backlinks list',
      })
      await backlinksList({
        project,
        limit,
        release: getString(input.values, 'release'),
        source: parseSourceFlag(getString(input.values, 'source')),
        excludeCrawlers: getBoolean(input.values, 'exclude-crawlers'),
        format: input.format,
      })
    },
  },
  {
    path: ['backlinks', 'sources'],
    usage: 'canonry backlinks sources <project> [--exclude-crawlers] [--format json|jsonl]',
    options: {
      'exclude-crawlers': { type: 'boolean' },
    },
    run: async (input) => {
      const { backlinksSources } = await import('../commands/backlinks.js')
      const project = requireProject(input, 'backlinks sources',
        'canonry backlinks sources <project>')
      await backlinksSources({
        project,
        excludeCrawlers: getBoolean(input.values, 'exclude-crawlers'),
        format: input.format,
      })
    },
  },
  {
    path: ['backlinks', 'releases'],
    usage: 'canonry backlinks releases [--format json]',
    options: {},
    run: async (input) => {
      const { backlinksReleases } = await import('../commands/backlinks.js')
      await backlinksReleases({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'releases', 'latest'],
    usage: 'canonry backlinks releases latest [--format json]',
    options: {},
    run: async (input) => {
      const { backlinksLatestRelease } = await import('../commands/backlinks.js')
      await backlinksLatestRelease({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'extract'],
    usage: 'canonry backlinks extract <project> [--release <id>] [--wait] [--format json]',
    options: {
      release: stringOption(),
      wait: { type: 'boolean' },
    },
    run: async (input) => {
      const { backlinksExtract } = await import('../commands/backlinks.js')
      const project = requireProject(input, 'backlinks extract',
        'canonry backlinks extract <project> [--release <id>] [--wait]')
      await backlinksExtract({
        project,
        release: getString(input.values, 'release'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['backlinks', 'cache', 'prune'],
    usage: 'canonry backlinks cache prune --release <id> [--format json]',
    options: {
      release: stringOption(),
    },
    run: async (input) => {
      const { backlinksCachePrune } = await import('../commands/backlinks.js')
      const release = requireStringOption(input, 'release', {
        message: '--release is required',
        usage: 'canonry backlinks cache prune --release <id>',
        command: 'backlinks cache prune',
      })
      await backlinksCachePrune({
        release,
        format: input.format,
      })
    },
  },
]
