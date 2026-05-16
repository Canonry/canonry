import { createApiClient } from '../client.js'
import { CliError, EXIT_USER_ERROR } from '../cli-error.js'

/**
 * Endpoints `canonry get` knows how to source. Each entry maps a `--from`
 * value to a fetcher that returns the JSON payload for the project.
 * Default is `'overview'` because that's the agent's most common path
 * lookup — "what's `scores.mentionShare.value` for project X" beats
 * any other field-fetching question by a wide margin.
 */
type GetSource = 'overview' | 'doctor' | 'runs' | 'queries' | 'competitors'

const SOURCE_FETCHERS: Record<GetSource, (project: string) => Promise<unknown>> = {
  overview: async (project) => createApiClient().getProjectOverview(project),
  doctor: async (project) => createApiClient().runDoctor({ project }),
  runs: async (project) => createApiClient().listRuns(project),
  queries: async (project) => createApiClient().listQueries(project),
  competitors: async (project) => createApiClient().listCompetitors(project),
}

export const GET_SOURCES: readonly GetSource[] = ['overview', 'doctor', 'runs', 'queries', 'competitors']

export interface GetOptions {
  project: string
  path: string
  from?: string
  format?: string
}

/**
 * `canonry get <project> <path> [--from <endpoint>]` — field-extraction
 * primitive for agents. Replaces the verbose `canonry overview <project>
 * --format json | jq '.scores.mentionShare.value'` pattern with a single
 * native invocation that returns the leaf value directly (scalars on
 * stdout as-is, objects/arrays as JSON).
 *
 * Path syntax is dot notation with `[<index>]` for arrays:
 *   scores.mentionShare.value             → reads `scores.mentionShare.value`
 *   scores.mentionShare.breakdown.perCompetitor[0].domain
 *   competitors[2].pressureLabel
 *
 * Designed so an agent can compose with shell: `count=$(canonry get
 * demand-iq summary.fail --from doctor)` — scalar leaves print without
 * quotes for one-liners; object/array leaves print as JSON so structured
 * results stay parseable.
 */
export async function getCommand(opts: GetOptions): Promise<void> {
  const source = (opts.from ?? 'overview') as GetSource
  if (!GET_SOURCES.includes(source)) {
    throw new CliError({
      code: 'INVALID_GET_SOURCE',
      message: `Unknown --from value "${opts.from}". Valid: ${GET_SOURCES.join(', ')}.`,
      exitCode: EXIT_USER_ERROR,
      details: { from: opts.from, valid: [...GET_SOURCES] },
    })
  }

  const payload = await SOURCE_FETCHERS[source](opts.project)
  const leaf = walkPath(payload, opts.path)

  if (leaf === undefined) {
    throw new CliError({
      code: 'PATH_NOT_FOUND',
      message: `Path "${opts.path}" not found in ${source} response for project "${opts.project}".`,
      exitCode: EXIT_USER_ERROR,
      details: { project: opts.project, path: opts.path, from: source },
    })
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(leaf, null, 2))
    return
  }

  // Scalar leaves print bare so shell pipelines can `$(…)`-capture them
  // without `jq -r`. Structured leaves print as JSON because there's no
  // sensible human pretty-print for arbitrary nested shapes.
  if (typeof leaf === 'string') {
    console.log(leaf)
  } else if (typeof leaf === 'number' || typeof leaf === 'boolean' || leaf === null) {
    console.log(String(leaf))
  } else {
    console.log(JSON.stringify(leaf, null, 2))
  }
}

/**
 * Walk a dot/bracket path through a JSON-shaped value. Returns `undefined`
 * for any path that doesn't resolve (missing key, out-of-range index,
 * scalar where the path expected an object). Bracket syntax for arrays
 * only — `foo[0].bar`, not `foo.0.bar`.
 *
 * Exported for unit testing — the walk semantics are subtle enough
 * (bracket parsing, undefined propagation) that tests want to exercise
 * the function directly without spinning up the API client.
 */
export function walkPath(value: unknown, path: string): unknown {
  if (!path || path === '.') return value
  const segments = path
    .split('.')
    .flatMap(part => {
      // Split `foo[0][1]` into ['foo', '[0]', '[1]'] so each becomes a
      // discrete step in the walk.
      const tokens: string[] = []
      let i = 0
      const bracketStart = part.indexOf('[')
      if (bracketStart === -1) {
        tokens.push(part)
      } else {
        if (bracketStart > 0) tokens.push(part.slice(0, bracketStart))
        i = bracketStart
        while (i < part.length) {
          if (part[i] === '[') {
            const end = part.indexOf(']', i)
            if (end === -1) return [part] // malformed — let caller see undefined
            tokens.push(part.slice(i, end + 1))
            i = end + 1
          } else {
            i++
          }
        }
      }
      return tokens
    })

  let cursor: unknown = value
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined

    if (segment.startsWith('[') && segment.endsWith(']')) {
      const idx = Number.parseInt(segment.slice(1, -1), 10)
      if (Number.isNaN(idx) || !Array.isArray(cursor)) return undefined
      cursor = cursor[idx]
      continue
    }

    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
