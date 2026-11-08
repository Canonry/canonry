import { siteAuditIssueListQuerySchema } from '@canonry/canonry-contracts'
import { CliError, usageError } from '../cli-error.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'

function parseOptionalBoolean(
  input: CliCommandInput,
  key: string,
  config: { command: string; usage: string },
): boolean | undefined {
  const value = getString(input.values, key)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw usageError(`Error: --${key} must be true or false\nUsage: ${config.usage}`, {
    message: `--${key} must be true or false`,
    details: { command: config.command, usage: config.usage, option: key, value },
  })
}

function isSiteHealthScope(value: string | undefined): value is 'all' | 'pages' | 'links' {
  return value === 'all' || value === 'pages' || value === 'links'
}

function isSiteHealthChange(value: string | undefined): value is 'all' | 'added' | 'removed' | 'changed' {
  return value === 'all' || value === 'added' || value === 'removed' || value === 'changed'
}

function auditIssueSelection(input: CliCommandInput, command: string, usage: string) {
  const limit = getString(input.values, 'limit')
  const selection = siteAuditIssueListQuerySchema.safeParse({
    runId: getString(input.values, 'run-id'),
    cursor: getString(input.values, 'cursor'),
    limit: limit === undefined ? undefined : Number(limit),
  })
  if (!selection.success) {
    throw usageError(`Error: invalid saved audit selection\nUsage: ${usage}`, {
      message: 'Use non-empty run and cursor IDs, and an integer --limit from 1 to 100.',
      details: { command, usage },
    })
  }
  return selection.data
}

const AGENT_READINESS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['agent-readiness', 'issues'],
    usage: 'canonry agent-readiness issues <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    access: 'stored',
    options: { 'run-id': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const { technicalAeoIssues } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness issues <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.issues', usage)
      await technicalAeoIssues(project, {
        ...auditIssueSelection(input, 'agent-readiness.issues', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'issue-pages'],
    usage: 'canonry agent-readiness issue-pages <project> --issue-id <id> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    access: 'stored',
    options: { 'issue-id': stringOption(), 'run-id': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const { technicalAeoIssuePages } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness issue-pages <project> --issue-id <id> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.issue-pages', usage)
      const issueId = requireStringOption(input, 'issue-id', { command: 'agent-readiness.issue-pages', usage, message: '--issue-id is required' })
      await technicalAeoIssuePages(project, {
        issueId,
        ...auditIssueSelection(input, 'agent-readiness.issue-pages', usage),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'score'],
    usage: 'canonry agent-readiness score <project> [--run-id <id>] [--format json]',
    options: {
      'run-id': stringOption(),
    },
    run: async (input) => {
      const { technicalAeoScore } = await import('../commands/technical-aeo.js')
      const project = requireProject(
        input,
        'agent-readiness.score',
        'canonry agent-readiness score <project> [--run-id <id>] [--format json]',
      )
      await technicalAeoScore(project, { runId: getString(input.values, 'run-id'), format: input.format })
    },
  },
  {
    path: ['agent-readiness', 'page-scores'],
    usage: 'canonry agent-readiness page-scores <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      status: stringOption(),
      sort: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const { technicalAeoPages } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness page-scores <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.page-scores', usage)
      await technicalAeoPages(project, {
        runId: getString(input.values, 'run-id'),
        status: getString(input.values, 'status'),
        sort: getString(input.values, 'sort'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'agent-readiness.page-scores',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'trend'],
    usage: 'canonry agent-readiness trend <project> [--limit <n>] [--format json|jsonl]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const { technicalAeoTrend } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness trend <project> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.trend', usage)
      await technicalAeoTrend(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'agent-readiness.trend',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'run'],
    usage: 'canonry agent-readiness run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--include-geo] [--no-agent-skills] [--wait] [--format json]',
    help: 'Start an Agent Readiness scan. No answer-engine provider is required. Without --max-pages the scan uses the project\'s saved page budget (canonry project update <project> --site-audit-max-pages <n|full>), else the full site, up to 50,000 pages. --wait polls for up to 15 minutes, so a large full-site scan can outlast it; follow it with canonry agent-readiness progress <project> --run-id <id>. Dead-link checking is off unless --check-dead-links is set. Add --include-geo for location and service-area checks. Agent integration checks are on by default; use --no-agent-skills to disable them.',
    options: {
      'sitemap-url': stringOption(),
      limit: stringOption(),
      'max-pages': stringOption(),
      'max-edges': stringOption(),
      'max-depth': stringOption(),
      'check-dead-links': { type: 'boolean', default: false },
      'include-geo': { type: 'boolean', default: false },
      'include-agent-skills': { type: 'boolean', default: true },
      'no-agent-skills': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { technicalAeoRun } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--include-geo] [--no-agent-skills] [--wait] [--format json]'
      const project = requireProject(input, 'agent-readiness.run', usage)
      await technicalAeoRun(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'agent-readiness.run',
          usage,
          message: '--limit must be an integer',
        }),
        maxPages: parseIntegerOption(input, 'max-pages', {
          command: 'agent-readiness.run', usage, message: '--max-pages must be an integer',
        }),
        maxEdges: parseIntegerOption(input, 'max-edges', {
          command: 'agent-readiness.run', usage, message: '--max-edges must be an integer',
        }),
        maxDepth: parseIntegerOption(input, 'max-depth', {
          command: 'agent-readiness.run', usage, message: '--max-depth must be an integer',
        }),
        checkDeadLinks: getBoolean(input.values, 'check-dead-links'),
        includeGeo: getBoolean(input.values, 'include-geo'),
        includeAgentSkills: getBoolean(input.values, 'include-agent-skills') && !getBoolean(input.values, 'no-agent-skills'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'overview'],
    usage: 'canonry agent-readiness overview <project> [--run-id <id> | --date YYYY-MM-DD] [--format json]',
    options: { 'run-id': stringOption(), date: stringOption() },
    run: async (input) => {
      const { technicalAeoCrawl } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness overview <project> [--run-id <id> | --date YYYY-MM-DD] [--format json]'
      const project = requireProject(input, 'agent-readiness.overview', usage)
      await technicalAeoCrawl(project, { runId: getString(input.values, 'run-id'), date: getString(input.values, 'date'), format: input.format })
    },
  },
  {
    path: ['agent-readiness', 'progress'],
    usage: 'canonry agent-readiness progress <project> --run-id <id> [--format json]',
    options: { 'run-id': stringOption() },
    run: async (input) => {
      const { technicalAeoProgress } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness progress <project> --run-id <id> [--format json]'
      const project = requireProject(input, 'agent-readiness.progress', usage)
      const runId = requireStringOption(input, 'run-id', {
        command: 'agent-readiness.progress',
        usage,
        message: '--run-id is required',
      })
      await technicalAeoProgress(project, { runId, format: input.format })
    },
  },
  {
    path: ['agent-readiness', 'subgraph'],
    usage: 'canonry agent-readiness subgraph <project> [--run-id <id>] [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json]',
    options: {
      'run-id': stringOption(), 'node-key': stringOption(), url: stringOption(), hops: stringOption(),
      'max-nodes': stringOption(), 'max-edges': stringOption(),
    },
    run: async (input) => {
      const { technicalAeoSubgraph } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness subgraph <project> [--run-id <id>] [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json]'
      const project = requireProject(input, 'agent-readiness.subgraph', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (nodeKey && url) {
        throw usageError(`Error: --node-key and --url cannot be combined\nUsage: ${usage}`, {
          message: '--node-key and --url cannot be combined', details: { command: 'agent-readiness.subgraph', usage },
        })
      }
      await technicalAeoSubgraph(project, {
        runId: getString(input.values, 'run-id'), nodeKey, url,
        hops: parseIntegerOption(input, 'hops', { command: 'agent-readiness.subgraph', usage, message: '--hops must be an integer' }),
        maxNodes: parseIntegerOption(input, 'max-nodes', { command: 'agent-readiness.subgraph', usage, message: '--max-nodes must be an integer' }),
        maxEdges: parseIntegerOption(input, 'max-edges', { command: 'agent-readiness.subgraph', usage, message: '--max-edges must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'path'],
    usage: 'canonry agent-readiness path <project> (--to-node-key <key>|--to-url <url>) [--run-id <id>] [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json]',
    options: {
      'run-id': stringOption(), 'from-node-key': stringOption(), 'from-url': stringOption(),
      'to-node-key': stringOption(), 'to-url': stringOption(), 'max-depth': stringOption(),
    },
    run: async (input) => {
      const { technicalAeoPath } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness path <project> (--to-node-key <key>|--to-url <url>) [--run-id <id>] [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json]'
      const project = requireProject(input, 'agent-readiness.path', usage)
      const fromNodeKey = getString(input.values, 'from-node-key')
      const fromUrl = getString(input.values, 'from-url')
      const toNodeKey = getString(input.values, 'to-node-key')
      const toUrl = getString(input.values, 'to-url')
      if (!toNodeKey && !toUrl) {
        throw usageError(`Error: --to-node-key or --to-url is required\nUsage: ${usage}`, {
          message: '--to-node-key or --to-url is required', details: { command: 'agent-readiness.path', usage },
        })
      }
      if ((fromNodeKey && fromUrl) || (toNodeKey && toUrl)) {
        throw usageError(`Error: node-key and URL selectors cannot be combined\nUsage: ${usage}`, {
          message: 'node-key and URL selectors cannot be combined', details: { command: 'agent-readiness.path', usage },
        })
      }
      await technicalAeoPath(project, {
        runId: getString(input.values, 'run-id'), fromNodeKey, fromUrl, toNodeKey, toUrl,
        maxDepth: parseIntegerOption(input, 'max-depth', { command: 'agent-readiness.path', usage, message: '--max-depth must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'changes'],
    usage: 'canonry agent-readiness changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'from-run-id': stringOption(), 'to-run-id': stringOption(), scope: stringOption(), change: stringOption(),
      cursor: stringOption(), limit: stringOption(),
    },
    run: async (input) => {
      const { technicalAeoChanges } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.changes', usage)
      const fromRunId = getString(input.values, 'from-run-id')
      const toRunId = getString(input.values, 'to-run-id')
      const scope = getString(input.values, 'scope')
      const change = getString(input.values, 'change')
      if (scope !== undefined && !isSiteHealthScope(scope)) {
        throw usageError(`Error: --scope must be all, pages, or links\nUsage: ${usage}`, {
          message: '--scope must be all, pages, or links', details: { command: 'agent-readiness.changes', usage, option: 'scope', value: scope },
        })
      }
      if (change !== undefined && !isSiteHealthChange(change)) {
        throw usageError(`Error: --change must be all, added, removed, or changed\nUsage: ${usage}`, {
          message: '--change must be all, added, removed, or changed', details: { command: 'agent-readiness.changes', usage, option: 'change', value: change },
        })
      }
      await technicalAeoChanges(project, {
        fromRunId, toRunId, scope,
        change,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.changes', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'pages'],
    usage: 'canonry agent-readiness pages <project> [--run-id <id> | --date YYYY-MM-DD] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--url-versions include|exclude|only] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(), date: stringOption(),
      'inventory-eligible': stringOption(),
      'fetch-state': stringOption(),
      'indexability-state': stringOption(),
      'audit-state': stringOption(),
      'url-versions': stringOption(),
      sort: stringOption(),
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const { technicalAeoCrawlPages } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness pages <project> [--run-id <id> | --date YYYY-MM-DD] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--url-versions include|exclude|only] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.pages', usage)
      const sort = getString(input.values, 'sort')
      if (sort !== undefined && !['url', 'path', 'score-asc', 'score-desc'].includes(sort)) {
        throw usageError(`Error: --sort must be url, path, score-asc, or score-desc\nUsage: ${usage}`, {
          message: '--sort must be url, path, score-asc, or score-desc',
          details: { command: 'agent-readiness.pages', usage, option: 'sort', value: sort },
        })
      }
      const urlVersions = getString(input.values, 'url-versions')
      if (urlVersions !== undefined && !['include', 'exclude', 'only'].includes(urlVersions)) {
        throw usageError(`Error: --url-versions must be include, exclude, or only\nUsage: ${usage}`, {
          message: '--url-versions must be include, exclude, or only',
          details: { command: 'agent-readiness.pages', usage, option: 'url-versions', value: urlVersions },
        })
      }
      await technicalAeoCrawlPages(project, {
        runId: getString(input.values, 'run-id'), date: getString(input.values, 'date'),
        inventoryEligible: parseOptionalBoolean(input, 'inventory-eligible', { command: 'agent-readiness.pages', usage }),
        fetchState: getString(input.values, 'fetch-state'),
        indexabilityState: getString(input.values, 'indexability-state'),
        auditState: getString(input.values, 'audit-state'),
        urlVersions: urlVersions as 'include' | 'exclude' | 'only' | undefined,
        sort: sort as 'url' | 'path' | 'score-asc' | 'score-desc' | undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.pages', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'page-audit'],
    usage: 'canonry agent-readiness page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json]',
    options: { 'run-id': stringOption(), 'node-key': stringOption(), url: stringOption() },
    run: async (input) => {
      const { technicalAeoPageAudit } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json]'
      const project = requireProject(input, 'agent-readiness.page-audit', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (!nodeKey && !url) {
        throw usageError(`Error: --node-key or --url is required\nUsage: ${usage}`, {
          message: '--node-key or --url is required', details: { command: 'agent-readiness.page-audit', usage },
        })
      }
      if (nodeKey && url) {
        throw usageError(`Error: --node-key and --url cannot be combined\nUsage: ${usage}`, {
          message: '--node-key and --url cannot be combined', details: { command: 'agent-readiness.page-audit', usage },
        })
      }
      await technicalAeoPageAudit(project, {
        runId: getString(input.values, 'run-id'),
        nodeKey,
        url,
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'structure'],
    usage: 'canonry agent-readiness structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), 'parent-path': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const { technicalAeoStructure } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.structure', usage)
      await technicalAeoStructure(project, {
        runId: getString(input.values, 'run-id'),
        parentPath: getString(input.values, 'parent-path'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.structure', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'links'],
    usage: 'canonry agent-readiness links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      'source-url': stringOption(),
      'target-url': stringOption(),
      followable: { type: 'boolean', default: false },
      nofollow: { type: 'boolean', default: false },
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const { technicalAeoInternalLinks } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.links', usage)
      const followable = getBoolean(input.values, 'followable')
      const nofollow = getBoolean(input.values, 'nofollow')
      if (followable && nofollow) {
        throw usageError(`Error: --followable and --nofollow cannot be combined\nUsage: ${usage}`, {
          message: '--followable and --nofollow cannot be combined',
          details: { command: 'agent-readiness.links', usage },
        })
      }
      await technicalAeoInternalLinks(project, {
        runId: getString(input.values, 'run-id'),
        sourceUrl: getString(input.values, 'source-url'),
        targetUrl: getString(input.values, 'target-url'),
        followable: followable ? true : nofollow ? false : undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'neighbors'],
    usage: 'canonry agent-readiness neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]',
    options: { 'run-id': stringOption(), 'node-key': stringOption(), url: stringOption(), limit: stringOption() },
    run: async (input) => {
      const { technicalAeoLinkNeighbors } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]'
      const project = requireProject(input, 'agent-readiness.neighbors', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (!nodeKey && !url) {
        throw usageError(`Error: --node-key or --url is required\nUsage: ${usage}`, {
          message: '--node-key or --url is required', details: { command: 'agent-readiness.neighbors', usage },
        })
      }
      await technicalAeoLinkNeighbors(project, {
        runId: getString(input.values, 'run-id'),
        nodeKey,
        url,
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.neighbors', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['agent-readiness', 'dead-links'],
    usage: 'canonry agent-readiness dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const { technicalAeoDeadLinks } = await import('../commands/technical-aeo.js')
      const usage = 'canonry agent-readiness dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'agent-readiness.dead-links', usage)
      await technicalAeoDeadLinks(project, {
        runId: getString(input.values, 'run-id'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'agent-readiness.dead-links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
]

/**
 * Deprecated names for the canonical `agent-readiness` commands, as
 * [deprecated path, canonical path]: the whole `technical-aeo` family and the
 * `site-health` reads. They keep existing scripts and agents working and are
 * removed only in a future major version.
 */
const DEPRECATED_AGENT_READINESS_CLI_ALIASES: ReadonlyArray<readonly [alias: readonly string[], canonical: readonly string[]]> = [
  [['technical-aeo', 'score'], ['agent-readiness', 'score']],
  [['technical-aeo', 'pages'], ['agent-readiness', 'page-scores']],
  [['technical-aeo', 'trend'], ['agent-readiness', 'trend']],
  [['technical-aeo', 'run'], ['agent-readiness', 'run']],
  [['technical-aeo', 'progress'], ['agent-readiness', 'progress']],
  [['technical-aeo', 'crawl'], ['agent-readiness', 'overview']],
  [['technical-aeo', 'crawl-pages'], ['agent-readiness', 'pages']],
  [['technical-aeo', 'page-audit'], ['agent-readiness', 'page-audit']],
  [['technical-aeo', 'issues'], ['agent-readiness', 'issues']],
  [['technical-aeo', 'issue-pages'], ['agent-readiness', 'issue-pages']],
  [['technical-aeo', 'structure'], ['agent-readiness', 'structure']],
  [['technical-aeo', 'links'], ['agent-readiness', 'links']],
  [['technical-aeo', 'links', 'neighbors'], ['agent-readiness', 'neighbors']],
  [['technical-aeo', 'dead-links'], ['agent-readiness', 'dead-links']],
  [['technical-aeo', 'subgraph'], ['agent-readiness', 'subgraph']],
  [['technical-aeo', 'path'], ['agent-readiness', 'path']],
  [['technical-aeo', 'changes'], ['agent-readiness', 'changes']],
  [['site-health', 'overview'], ['agent-readiness', 'overview']],
  [['site-health', 'pages'], ['agent-readiness', 'pages']],
  [['site-health', 'page-audit'], ['agent-readiness', 'page-audit']],
  [['site-health', 'issues'], ['agent-readiness', 'issues']],
  [['site-health', 'issue-pages'], ['agent-readiness', 'issue-pages']],
  [['site-health', 'structure'], ['agent-readiness', 'structure']],
  [['site-health', 'links'], ['agent-readiness', 'links']],
  [['site-health', 'neighbors'], ['agent-readiness', 'neighbors']],
  [['site-health', 'dead-links'], ['agent-readiness', 'dead-links']],
  [['site-health', 'subgraph'], ['agent-readiness', 'subgraph']],
  [['site-health', 'path'], ['agent-readiness', 'path']],
  [['site-health', 'changes'], ['agent-readiness', 'changes']],
]

/**
 * One deprecated name for a canonical command. It runs the canonical
 * implementation, so options, output, JSON and exit codes are the same; its
 * usage line keeps the canonical flags, and a usage error names the alias the
 * caller typed.
 */
function deprecatedAlias(aliasPath: readonly string[], canonicalPath: readonly string[]): CliCommandSpec {
  const canonical = AGENT_READINESS_CLI_COMMANDS.find(
    (candidate) => candidate.path.join(' ') === canonicalPath.join(' '),
  )
  if (!canonical) throw new Error(`Missing Agent Readiness command for deprecated alias: ${aliasPath.join(' ')}`)
  const canonicalPrefix = `canonry ${canonical.path.join(' ')} `
  if (!canonical.usage.startsWith(canonicalPrefix)) {
    throw new Error(`Agent Readiness usage must start with "${canonicalPrefix}": ${canonical.usage}`)
  }
  const usage = `canonry ${aliasPath.join(' ')} ${canonical.usage.slice(canonicalPrefix.length)}`
  const command = aliasPath.join('.')
  return {
    ...canonical,
    path: aliasPath,
    usage,
    deprecatedAliasOf: canonical.path,
    run: async (input) => {
      try {
        await canonical.run(input)
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== 'CLI_USAGE_ERROR') throw error
        const firstLine = error.displayMessage?.split('\n', 1)[0] ?? `Error: ${error.message}`
        throw usageError(`${firstLine}\nUsage: ${usage}`, {
          message: error.message,
          details: { ...error.details, command, usage },
        })
      }
    },
  }
}

/**
 * `agent-readiness` is the canonical family; `technical-aeo` and `site-health`
 * remain as deprecated names for it.
 */
export const TECHNICAL_AEO_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...AGENT_READINESS_CLI_COMMANDS,
  ...DEPRECATED_AGENT_READINESS_CLI_ALIASES.map(([alias, canonical]) => deprecatedAlias(alias, canonical)),
]
