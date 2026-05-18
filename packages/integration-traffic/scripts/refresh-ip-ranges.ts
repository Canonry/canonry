#!/usr/bin/env tsx
/**
 * Refreshes every bundled crawler IP-range JSON from its upstream
 * publisher. Run when an operator updates their list (typically
 * weekly cadence for the big ones — they add ranges as they spin up
 * new datacenter capacity).
 *
 * Usage (from repo root):
 *   pnpm --filter @ainyc/canonry-integration-traffic exec tsx scripts/refresh-ip-ranges.ts
 *
 * Or directly:
 *   tsx packages/integration-traffic/scripts/refresh-ip-ranges.ts
 *
 * Writes pretty-printed JSON so `git diff` shows exactly which
 * prefixes the operator added / removed. Exit code is 0 even on
 * partial failure (still updates the lists that succeeded); prints
 * a per-source summary to stderr.
 *
 * Operators NOT covered here either don't publish a public JSON
 * (Anthropic, Meta, ByteDance, Apple, DeepSeek, Mistral, DuckDuckGo,
 * Yandex, Baidu, Amazon as of 2026) or publish in HTML-only doc
 * pages that need scraping. Add them by editing both `SOURCES` here
 * AND `RULE_ID_TO_RANGES` in `src/ip-verify.ts`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rangesDir = path.resolve(dirname, '..', 'src', 'ip-ranges')

interface Source {
  /** Filename under `src/ip-ranges/`. Must match the import in `ip-verify.ts`. */
  file: string
  /** Publisher URL — the operator's canonical JSON. */
  url: string
  /** Display label for the per-source progress line. */
  label: string
}

const SOURCES: Source[] = [
  {
    file: 'googlebot.json',
    url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    label: 'Googlebot',
  },
  {
    file: 'bingbot.json',
    url: 'https://www.bing.com/toolbox/bingbot.json',
    label: 'bingbot',
  },
  {
    file: 'gptbot.json',
    url: 'https://openai.com/gptbot.json',
    label: 'OpenAI GPTBot',
  },
  {
    file: 'chatgpt-user.json',
    url: 'https://openai.com/chatgpt-user.json',
    label: 'OpenAI ChatGPT-User',
  },
  {
    file: 'oai-searchbot.json',
    url: 'https://openai.com/searchbot.json',
    label: 'OpenAI OAI-SearchBot',
  },
  {
    file: 'perplexitybot.json',
    url: 'https://www.perplexity.ai/perplexitybot.json',
    label: 'PerplexityBot',
  },
  {
    file: 'perplexity-user.json',
    url: 'https://www.perplexity.ai/perplexity-user.json',
    label: 'Perplexity-User',
  },
]

interface FetchResult {
  source: Source
  ok: boolean
  prefixCount?: number
  error?: string
}

async function refreshOne(source: Source): Promise<FetchResult> {
  try {
    const res = await fetch(source.url, {
      headers: {
        // Some publishers (Bing) return a 403 to unidentified clients.
        // A vanilla `curl`-style UA gets through reliably.
        'User-Agent': 'canonry-ip-range-refresher/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return { source, ok: false, error: `HTTP ${res.status}` }
    }
    const json = await res.json() as { prefixes?: unknown[] }
    if (!json || !Array.isArray(json.prefixes)) {
      return { source, ok: false, error: 'response missing `prefixes` array' }
    }
    const target = path.join(rangesDir, source.file)
    await fs.writeFile(target, JSON.stringify(json, null, 2) + '\n', 'utf-8')
    return { source, ok: true, prefixCount: json.prefixes.length }
  } catch (err) {
    return {
      source,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function main() {
  process.stderr.write(`Refreshing ${SOURCES.length} crawler IP-range files in ${rangesDir}\n\n`)
  // Run in parallel — publishers are independent and the script is
  // bounded by request latency, not local CPU.
  const results = await Promise.all(SOURCES.map(refreshOne))
  let ok = 0
  let failed = 0
  for (const r of results) {
    if (r.ok) {
      ok++
      process.stderr.write(`  ✓ ${r.source.label.padEnd(24)} ${r.source.file}  (${r.prefixCount} prefixes)\n`)
    } else {
      failed++
      process.stderr.write(`  ✗ ${r.source.label.padEnd(24)} ${r.source.file}  ${r.error}\n`)
    }
  }
  process.stderr.write(`\nDone. ${ok} updated, ${failed} failed.\n`)
  if (failed > 0) {
    process.stderr.write(`Failed sources kept their previous JSON — re-run when reachable.\n`)
  }
}

await main()
