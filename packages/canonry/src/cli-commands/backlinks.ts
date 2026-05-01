import {
  backlinksCachePrune,
  backlinksDoctor,
  backlinksExtract,
  backlinksInstall,
  backlinksLatestRelease,
  backlinksList,
  backlinksReleases,
  backlinksStatus,
  backlinksSync,
} from '../commands/backlinks.js'
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
      await backlinksInstall({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'doctor'],
    usage: 'canonry backlinks doctor [--format json]',
    options: {},
    run: async (input) => {
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
      await backlinksStatus({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'list'],
    usage: 'canonry backlinks list <project> [--limit <n>] [--release <id>] [--exclude-crawlers] [--format json]',
    options: {
      limit: stringOption(),
      release: stringOption(),
      'exclude-crawlers': { type: 'boolean' },
    },
    run: async (input) => {
      const project = requireProject(input, 'backlinks list',
        'canonry backlinks list <project> [--limit <n>] [--release <id>] [--exclude-crawlers]')
      const limit = parseIntegerOption(input, 'limit', {
        message: '--limit must be an integer',
        usage: 'canonry backlinks list <project> --limit <n>',
        command: 'backlinks list',
      })
      await backlinksList({
        project,
        limit,
        release: getString(input.values, 'release'),
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
      await backlinksReleases({ format: input.format })
    },
  },
  {
    path: ['backlinks', 'releases', 'latest'],
    usage: 'canonry backlinks releases latest [--format json]',
    options: {},
    run: async (input) => {
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
