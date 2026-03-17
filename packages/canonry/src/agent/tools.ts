/**
 * Agent tools — canonry operations exposed as LLM-callable functions.
 *
 * Most tools use direct service layer calls to avoid circular HTTP dependency.
 * Write operations (run_sweep) and external integrations (GSC) still use HTTP
 * for proper job orchestration and auth handling.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentServices } from './services.js'
import type { ApiClient } from '../client.js'
import { loadFromConfigDir, saveToConfigDir } from './prompt.js'

export interface AgentTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<string>
}

const MAX_TOOL_RESULT_LENGTH = 20_000

function truncateResult(json: string): string {
  if (json.length <= MAX_TOOL_RESULT_LENGTH) return json
  return json.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n... (truncated — result too large)'
}

export interface AgentToolsConfig {
  /** Enable shell execution, file I/O, and HTTP tools. Default: false. */
  systemTools?: boolean
}

export function buildTools(services: AgentServices, client: ApiClient, projectName: string, config?: AgentToolsConfig): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'get_status',
      description:
        'Get the current citation visibility status for this project. Returns domain, country, latest run info.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const project = await services.getProject(projectName)
        const runs = await services.listRuns(projectName)
        return truncateResult(JSON.stringify({ project, latestRuns: runs.slice(0, 3) }, null, 2))
      },
    },
    {
      name: 'run_sweep',
      description:
        'Trigger a new visibility sweep across configured AI providers. Returns the run ID. Use this when the user wants fresh data.',
      parameters: {
        type: 'object',
        properties: {
          providers: {
            type: 'string',
            description: 'Comma-separated provider names to sweep. Omit for all configured providers.',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const body: Record<string, unknown> = {}
        if (args.providers) {
          body.providers = (args.providers as string).split(',').map(s => s.trim())
        }
        const run = await client.triggerRun(projectName, body)
        return truncateResult(JSON.stringify(run, null, 2))
      },
    },
    {
      name: 'get_evidence',
      description:
        'Get per-keyword citation evidence showing which providers cite this project and which competitors appear instead. This is the primary tool for understanding visibility.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const history = await services.getHistory(projectName)
        return truncateResult(JSON.stringify(history, null, 2))
      },
    },
    {
      name: 'get_timeline',
      description:
        'Get the citation timeline showing how visibility has changed across runs over time. Use this to identify trends, regressions, or improvements.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const timeline = await services.getTimeline(projectName)
        return truncateResult(JSON.stringify(timeline, null, 2))
      },
    },
    {
      name: 'list_keywords',
      description: 'List all tracked keywords for this project.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const keywords = await services.listKeywords(projectName)
        return truncateResult(JSON.stringify(keywords, null, 2))
      },
    },
    {
      name: 'list_competitors',
      description: 'List tracked competitors for this project.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const competitors = await services.listCompetitors(projectName)
        return truncateResult(JSON.stringify(competitors, null, 2))
      },
    },
    {
      name: 'add_keywords',
      description: 'Add new keywords to track for this project. Accepts one or more keywords.',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'string',
            description: 'Comma-separated list of keywords to add.',
          },
        },
        required: ['keywords'],
      },
      execute: async (args) => {
        const kws = (args.keywords as string).split(',').map(s => s.trim()).filter(Boolean)
        await client.appendKeywords(projectName, kws)
        return JSON.stringify({ added: kws, count: kws.length })
      },
    },
    {
      name: 'remove_keywords',
      description: 'Remove keywords from tracking. Confirm with the user before calling this.',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'string',
            description: 'Comma-separated list of keywords to remove.',
          },
        },
        required: ['keywords'],
      },
      execute: async (args) => {
        const kws = (args.keywords as string).split(',').map(s => s.trim()).filter(Boolean)
        await client.deleteKeywords(projectName, kws)
        return JSON.stringify({ removed: kws, count: kws.length })
      },
    },
    {
      name: 'add_competitors',
      description: 'Add competitor domains to track for this project.',
      parameters: {
        type: 'object',
        properties: {
          competitors: {
            type: 'string',
            description: 'Comma-separated list of competitor domains (e.g. "competitor1.com, competitor2.com").',
          },
        },
        required: ['competitors'],
      },
      execute: async (args) => {
        const existing = await services.listCompetitors(projectName)
        const existingDomains = existing.map((c: Record<string, unknown>) => String(c.domain ?? c.name ?? ''))
        const newDomains = (args.competitors as string).split(',').map(s => s.trim()).filter(Boolean)
        const merged = [...new Set([...existingDomains, ...newDomains])]
        await client.putCompetitors(projectName, merged)
        return JSON.stringify({ added: newDomains, total: merged.length })
      },
    },
    {
      name: 'remove_competitors',
      description: 'Remove competitor domains from tracking. Confirm with the user before calling this.',
      parameters: {
        type: 'object',
        properties: {
          competitors: {
            type: 'string',
            description: 'Comma-separated list of competitor domains to remove.',
          },
        },
        required: ['competitors'],
      },
      execute: async (args) => {
        const existing = await services.listCompetitors(projectName)
        const existingDomains = existing.map((c: Record<string, unknown>) => String(c.domain ?? c.name ?? ''))
        const toRemove = new Set((args.competitors as string).split(',').map(s => s.trim()).filter(Boolean))
        const remaining = existingDomains.filter(d => !toRemove.has(d))
        await client.putCompetitors(projectName, remaining)
        return JSON.stringify({ removed: [...toRemove], remaining: remaining.length })
      },
    },
    {
      name: 'update_project',
      description: 'Update project settings. Only include fields you want to change.',
      parameters: {
        type: 'object',
        properties: {
          displayName: {
            type: 'string',
            description: 'New display name for the project.',
          },
          domain: {
            type: 'string',
            description: 'New canonical domain (e.g. "example.com").',
          },
          country: {
            type: 'string',
            description: 'Two-letter country code (e.g. "US").',
          },
          language: {
            type: 'string',
            description: 'Two-letter language code (e.g. "en").',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const body: Record<string, unknown> = {}
        if (args.displayName) body.displayName = args.displayName
        if (args.domain) body.canonicalDomain = args.domain
        if (args.country) body.country = args.country
        if (args.language) body.language = args.language
        const result = await client.putProject(projectName, body)
        return truncateResult(JSON.stringify(result, null, 2))
      },
    },
    {
      name: 'get_run_details',
      description: 'Get detailed results for a specific run by ID, including all snapshots.',
      parameters: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'The run ID to inspect.',
          },
        },
        required: ['runId'],
      },
      execute: async (args) => {
        const run = await services.getRun(args.runId as string, projectName)
        return truncateResult(JSON.stringify(run, null, 2))
      },
    },
    {
      name: 'get_gsc_performance',
      description:
        'Get Google Search Console performance data (clicks, impressions, CTR, position) for tracked keywords. Only works if GSC is connected.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'string',
            description: 'Number of days to look back (default: 28).',
          },
        },
        required: [],
      },
      execute: async (args) => {
        try {
          const params: Record<string, string> = {}
          if (args.days) params.days = args.days as string
          const perf = await client.gscPerformance(projectName, params)
          return truncateResult(JSON.stringify(perf, null, 2))
        } catch (err) {
          return `GSC not available: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
    {
      name: 'get_gsc_coverage',
      description:
        'Get index coverage summary from Google Search Console showing how many URLs are indexed, excluded, or errored.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        try {
          const coverage = await client.gscCoverage(projectName)
          return truncateResult(JSON.stringify(coverage, null, 2))
        } catch (err) {
          return `GSC not available: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
    {
      name: 'inspect_url',
      description:
        'Inspect a specific URL in Google Search Console to check indexing status, crawl info, and mobile-friendliness.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to inspect (e.g. https://example.com/page).',
          },
        },
        required: ['url'],
      },
      execute: async (args) => {
        try {
          const result = await client.gscInspect(projectName, args.url as string)
          return truncateResult(JSON.stringify(result, null, 2))
        } catch (err) {
          return `GSC inspect failed: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
    // ── Memory tools ──────────────────────────────────────────
    {
      name: 'get_memory',
      description:
        'Read persistent memory from ~/.canonry/memory.md. Contains domain knowledge, project observations, patterns, and user preferences accumulated across sessions.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const content = loadFromConfigDir('memory.md')
        return content ?? '(No memory file found. Use save_memory to create one.)'
      },
    },
    {
      name: 'save_memory',
      description:
        'Write updated memory to ~/.canonry/memory.md. Use this to persist observations, patterns, project knowledge, and user preferences across sessions. Send the FULL memory content (not just the new part) since this overwrites the file.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The full memory.md content to write. Preserve existing domain knowledge sections and append new observations.',
          },
        },
        required: ['content'],
      },
      execute: async (args) => {
        const content = args.content as string
        saveToConfigDir('memory.md', content)
        return JSON.stringify({ saved: true, bytes: content.length })
      },
    },
  ]

  // ── System tools (opt-in) ────────────────────────────────
  if (config?.systemTools) {
    tools.push(
      {
        name: 'run_command',
        description:
          'Execute a shell command on the server and return stdout/stderr. Use this for installing packages, running canonry CLI commands, downloading files, running scripts, and system administration. Commands run with the server process permissions.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute (e.g. "npm install ...", "curl ...", "canonry keyword add ...").',
            },
            cwd: {
              type: 'string',
              description: 'Working directory for the command. Defaults to the canonry config directory.',
            },
            timeout: {
              type: 'string',
              description: 'Timeout in seconds. Default: 30. Max: 300.',
            },
          },
          required: ['command'],
        },
        execute: async (args) => {
          const command = args.command as string
          const configDir = process.env.CANONRY_CONFIG_DIR?.trim() ||
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.canonry')
          const cwd = (args.cwd as string) || configDir
          const timeoutSec = Math.min(parseInt(args.timeout as string || '30', 10) || 30, 300)

          try {
            const output = execSync(command, {
              cwd,
              timeout: timeoutSec * 1000,
              maxBuffer: 1024 * 1024, // 1MB
              encoding: 'utf-8',
              env: { ...process.env },
              shell: '/bin/sh',
            })
            return truncateResult(output || '(no output)')
          } catch (err) {
            const e = err as { stdout?: string; stderr?: string; status?: number; message?: string }
            const stdout = e.stdout?.trim() || ''
            const stderr = e.stderr?.trim() || ''
            const status = e.status ?? 1
            return truncateResult(`Exit code: ${status}\n${stdout}\n${stderr}`.trim())
          }
        },
      },
      {
        name: 'read_file',
        description:
          'Read a file from the server filesystem. Use for reading config files, logs, scripts, or any text file.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or relative path to the file. Relative paths resolve from ~/.canonry/.',
            },
            maxLines: {
              type: 'string',
              description: 'Maximum number of lines to return. Default: 500.',
            },
          },
          required: ['path'],
        },
        execute: async (args) => {
          const filePath = args.path as string
          const configDir = process.env.CANONRY_CONFIG_DIR?.trim() ||
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.canonry')
          const resolved = path.isAbsolute(filePath) ? filePath : path.join(configDir, filePath)
          const maxLines = parseInt(args.maxLines as string || '500', 10) || 500

          try {
            const content = fs.readFileSync(resolved, 'utf-8')
            const lines = content.split('\n')
            if (lines.length > maxLines) {
              return truncateResult(lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`)
            }
            return truncateResult(content)
          } catch (err) {
            return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      },
      {
        name: 'write_file',
        description:
          'Write content to a file on the server filesystem. Creates parent directories if needed. Use for creating scripts, config files, or saving data.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or relative path. Relative paths resolve from ~/.canonry/.',
            },
            content: {
              type: 'string',
              description: 'The file content to write.',
            },
            append: {
              type: 'string',
              description: 'Set to "true" to append instead of overwrite.',
            },
          },
          required: ['path', 'content'],
        },
        execute: async (args) => {
          const filePath = args.path as string
          const content = args.content as string
          const append = args.append === 'true'
          const configDir = process.env.CANONRY_CONFIG_DIR?.trim() ||
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.canonry')
          const resolved = path.isAbsolute(filePath) ? filePath : path.join(configDir, filePath)

          try {
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            if (append) {
              fs.appendFileSync(resolved, content, 'utf-8')
            } else {
              fs.writeFileSync(resolved, content, 'utf-8')
            }
            return JSON.stringify({ written: resolved, bytes: content.length, append })
          } catch (err) {
            return `Error writing file: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      },
      {
        name: 'list_files',
        description:
          'List files and directories at a given path. Useful for exploring the filesystem, finding configs, logs, or downloaded files.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to list. Defaults to ~/.canonry/.',
            },
          },
          required: [],
        },
        execute: async (args) => {
          const dirPath = args.path as string | undefined
          const configDir = process.env.CANONRY_CONFIG_DIR?.trim() ||
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.canonry')
          const resolved = dirPath ? (path.isAbsolute(dirPath) ? dirPath : path.join(configDir, dirPath)) : configDir

          try {
            const entries = fs.readdirSync(resolved, { withFileTypes: true })
            const items = entries.map(e => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined,
            }))
            return JSON.stringify(items, null, 2)
          } catch (err) {
            return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      },
      {
        name: 'http_request',
        description:
          'Make an HTTP request to any URL. Use for fetching web pages, APIs, downloading data, or checking URLs. Supports GET and POST.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to request.',
            },
            method: {
              type: 'string',
              description: 'HTTP method. Default: GET.',
              enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
            },
            body: {
              type: 'string',
              description: 'Request body (for POST/PUT/PATCH).',
            },
            headers: {
              type: 'string',
              description: 'JSON-encoded headers object.',
            },
          },
          required: ['url'],
        },
        execute: async (args) => {
          const url = args.url as string
          const method = (args.method as string) || 'GET'
          const headers: Record<string, string> = { 'User-Agent': 'Aero/1.0 (canonry agent)' }

          if (args.headers) {
            try {
              Object.assign(headers, JSON.parse(args.headers as string))
            } catch { /* ignore malformed headers */ }
          }

          try {
            const res = await fetch(url, {
              method,
              headers,
              body: args.body as string | undefined,
              signal: AbortSignal.timeout(30_000),
            })
            const text = await res.text()
            return truncateResult(`HTTP ${res.status} ${res.statusText}\n\n${text}`)
          } catch (err) {
            return `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      },
    )
  }

  return tools
}
