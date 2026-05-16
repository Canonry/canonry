#!/usr/bin/env tsx
/*
 * SoV Rework — empirical validation of the metric design proposed in
 * `plans/sov-rework.md`. Reads the live canonry SQLite database and computes:
 *
 *   A. Data availability per provider (do we even have grounding / searchQueries?)
 *   B. Cross-provider asymmetry (avg grounding count, cited count, ratio)
 *   C. Retrieval Share simulation vs current SoV
 *   D. Mention Share simulation
 *   E. GSC-source candidate volume
 *   F. Snapshot-mining candidate volume
 *   G. Hybrid overlap analysis
 *
 * Output: a markdown report (printed to stdout, optionally written to disk).
 *
 * Usage:
 *   pnpm tsx scripts/sov-rework-analysis.ts                  # all projects
 *   pnpm tsx scripts/sov-rework-analysis.ts --project ainyc  # one project
 *   pnpm tsx scripts/sov-rework-analysis.ts --out plans/sov-rework-analysis.md
 *
 * No DB writes. Pure read + report.
 */

import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
const Database = require_('better-sqlite3') as typeof import('better-sqlite3')
import fs from 'node:fs'
import path from 'node:path'

interface Args {
  project?: string
  dbPath: string
  out?: string
  lookbackDays: number
  minImpressions: number
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const home = process.env.HOME ?? ''
  return {
    project: get('--project'),
    dbPath: get('--db') ?? path.join(home, '.canonry', 'data.db'),
    out: get('--out'),
    lookbackDays: Number.parseInt(get('--lookback') ?? '30', 10),
    minImpressions: Number.parseInt(get('--min-impressions') ?? '10', 10),
  }
}

// ─── Domain matching (mirrors packages/intelligence/src/domain-matching.ts) ───
function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0]!.split(':')[0]!
}
function domainBelongsTo(cited: string, owned: readonly string[]): boolean {
  const c = normalizeDomain(cited)
  for (const o of owned) {
    const on = normalizeDomain(o)
    if (c === on || c.endsWith(`.${on}`)) return true
  }
  return false
}

// ─── Brand-token matching (mirrors effectiveBrandNames filter rules) ───
function brandTokensFromDomain(domain: string): string[] {
  const n = normalizeDomain(domain)
  const parts = n.split('.')
  // registrable: penultimate label (foo.com → 'foo'; offers.roofle.com → 'roofle')
  if (parts.length >= 2) return [parts[parts.length - 2]!]
  return [n]
}
function looksLikeBrandMention(text: string, token: string): boolean {
  if (token.length < 3) return false
  const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  return re.test(text)
}

// ─── Query normalization (for GSC vs tracked dedup) ───
const STOP_WORDS = new Set(['a', 'an', 'the', 'best', 'top', 'for', 'in', 'of', 'and', 'or', 'to', 'is', 'are'])
function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '')
}
function tokenSet(q: string): Set<string> {
  return new Set(normalizeQuery(q).split(/\s+/).filter(t => t && !STOP_WORDS.has(t)))
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  const inter = [...a].filter(x => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

// ─── Report builder helpers ───
function fmt(n: number, digits = 1): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 'n/a'
  return n.toFixed(digits)
}
function pct(num: number, denom: number, digits = 1): string {
  if (denom === 0) return 'n/a'
  return `${((num / denom) * 100).toFixed(digits)}%`
}
function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}
function p90(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.9)]!
}

// ─── Main analysis ───
function main(): void {
  const args = parseArgs()
  const db = new Database(args.dbPath, { readonly: true })
  const out: string[] = []
  const log = (s = ''): void => { out.push(s) }

  const projects = (args.project
    ? db.prepare('SELECT * FROM projects WHERE name = ?').all(args.project)
    : db.prepare('SELECT * FROM projects').all()
  ) as Array<{ id: string; name: string; canonical_domain: string; owned_domains: string; display_name: string | null; aliases: string }>

  if (projects.length === 0) {
    console.error(`No projects found${args.project ? ` matching ${args.project}` : ''}`)
    process.exit(1)
  }

  log('# SoV Rework — Empirical Analysis')
  log()
  log(`Generated: ${new Date().toISOString()}`)
  log(`DB: \`${args.dbPath}\``)
  log(`Projects analyzed: ${projects.length}`)
  log(`GSC lookback: ${args.lookbackDays} days, min impressions: ${args.minImpressions}`)
  log()
  log('---')

  for (const project of projects) {
    const projectDomains = [
      project.canonical_domain,
      ...(JSON.parse(project.owned_domains || '[]') as string[]),
    ]
    const projectName = project.display_name || project.name
    const brandTokens = [
      ...(JSON.parse(project.aliases || '[]') as string[]),
      projectName,
      project.canonical_domain.split('.')[0]!,
    ].filter(t => t.length >= 3)

    const competitors = db.prepare('SELECT id, domain FROM competitors WHERE project_id = ?').all(project.id) as Array<{ id: string; domain: string }>
    const competitorDomains = competitors.map(c => c.domain)

    const trackedQueries = db.prepare('SELECT query FROM queries WHERE project_id = ?').all(project.id) as Array<{ query: string }>
    const trackedTokenSets = trackedQueries.map(q => tokenSet(q.query))

    // Latest answer-visibility run group (most-recent createdAt — may include
    // multiple snapshots if there's a multi-location fan-out).
    const latestRunRow = db.prepare(`
      SELECT created_at FROM runs
      WHERE project_id = ? AND kind = 'answer-visibility' AND status IN ('completed', 'partial')
      ORDER BY created_at DESC LIMIT 1
    `).get(project.id) as { created_at: string } | undefined

    log()
    log(`## Project: \`${project.name}\` (${projectName})`)
    log()
    log(`- **Project domains:** ${projectDomains.join(', ')}`)
    log(`- **Competitors:** ${competitorDomains.length} configured — ${competitorDomains.slice(0, 5).join(', ')}${competitorDomains.length > 5 ? '…' : ''}`)
    log(`- **Tracked queries:** ${trackedQueries.length}`)
    log(`- **Latest visibility run:** ${latestRunRow?.created_at ?? 'never run'}`)
    log()

    if (!latestRunRow) {
      log('_No visibility runs yet — skipping snapshot analyses._')
      continue
    }

    const latestRuns = db.prepare(`
      SELECT id FROM runs
      WHERE project_id = ? AND kind = 'answer-visibility' AND created_at = ?
    `).all(project.id, latestRunRow.created_at) as Array<{ id: string }>
    const latestRunIds = latestRuns.map(r => r.id)
    const placeholders = latestRunIds.map(() => '?').join(',')

    const latestSnapshots = db.prepare(`
      SELECT provider, model, citation_state, answer_mentioned, answer_text,
             cited_domains, competitor_overlap, raw_response
      FROM query_snapshots
      WHERE run_id IN (${placeholders}) AND query_id IS NOT NULL
    `).all(...latestRunIds) as Array<{
      provider: string
      model: string | null
      citation_state: string
      answer_mentioned: number | null
      answer_text: string | null
      cited_domains: string
      competitor_overlap: string
      raw_response: string | null
    }>

    log(`### A. Data availability — latest run`)
    log()
    log(`Snapshots in latest run: ${latestSnapshots.length}`)
    log()

    type ProviderStats = {
      snapshots: number
      withGrounding: number
      withSearchQueries: number
      withAnswerText: number
      groundingCounts: number[]
      citedCounts: number[]
      searchQueryCounts: number[]
    }
    const byProvider = new Map<string, ProviderStats>()

    for (const snap of latestSnapshots) {
      const key = `${snap.provider}${snap.model ? `::${snap.model}` : ''}`
      const stats = byProvider.get(key) ?? {
        snapshots: 0, withGrounding: 0, withSearchQueries: 0, withAnswerText: 0,
        groundingCounts: [], citedCounts: [], searchQueryCounts: [],
      }
      stats.snapshots++

      const cited = JSON.parse(snap.cited_domains || '[]') as string[]
      stats.citedCounts.push(cited.length)

      const envelope = snap.raw_response ? safeJson(snap.raw_response) : {}
      const grounding = Array.isArray(envelope.groundingSources) ? envelope.groundingSources : []
      const groundingDomains = new Set<string>()
      for (const g of grounding) {
        if (g && typeof g.uri === 'string') {
          try {
            const u = new URL(g.uri.startsWith('http') ? g.uri : `https://${g.uri}`)
            groundingDomains.add(normalizeDomain(u.hostname))
          } catch {
            const titleMatch = typeof g.title === 'string' ? g.title.match(/[a-z0-9-]+\.[a-z]{2,}/i) : null
            if (titleMatch) groundingDomains.add(normalizeDomain(titleMatch[0]))
          }
        }
      }
      if (groundingDomains.size > 0) {
        stats.withGrounding++
        stats.groundingCounts.push(groundingDomains.size)
      }

      const searchQueries = Array.isArray(envelope.searchQueries) ? envelope.searchQueries : []
      if (searchQueries.length > 0) {
        stats.withSearchQueries++
        stats.searchQueryCounts.push(searchQueries.length)
      }

      if (snap.answer_text && snap.answer_text.length > 0) stats.withAnswerText++

      byProvider.set(key, stats)
    }

    log('| Provider | Snapshots | w/ Grounding | w/ SearchQueries | w/ AnswerText | Avg grounding | Avg cited | Grounding/cited ratio |')
    log('|---|---|---|---|---|---|---|---|')
    for (const [key, s] of byProvider) {
      const avgG = mean(s.groundingCounts)
      const avgC = mean(s.citedCounts)
      log(`| \`${key}\` | ${s.snapshots} | ${pct(s.withGrounding, s.snapshots, 0)} (${s.withGrounding}) | ${pct(s.withSearchQueries, s.snapshots, 0)} (${s.withSearchQueries}) | ${pct(s.withAnswerText, s.snapshots, 0)} (${s.withAnswerText}) | ${fmt(avgG)} | ${fmt(avgC)} | ${avgC > 0 ? fmt(avgG / avgC) : 'n/a'}× |`)
    }
    log()

    // ─── B + C. Retrieval Share simulation ───
    log(`### B/C. Retrieval Share simulation`)
    log()

    let totalGroundingSlots = 0
    let projectGroundingSlots = 0
    let competitorGroundingSlots = 0
    let totalCitedSlots = 0
    let projectCitedSlots = 0
    let competitorCitedSlots = 0
    const perProviderRetrievalShare: Array<{ key: string; share: number; slots: number }> = []

    for (const [key, stats] of byProvider) {
      let pSlots = 0
      let cSlots = 0
      let tSlots = 0
      const matching = latestSnapshots.filter(s => `${s.provider}${s.model ? `::${s.model}` : ''}` === key)
      for (const snap of matching) {
        const envelope = snap.raw_response ? safeJson(snap.raw_response) : {}
        const grounding = Array.isArray(envelope.groundingSources) ? envelope.groundingSources : []
        const seen = new Set<string>()
        for (const g of grounding) {
          let domain: string | null = null
          if (g && typeof g.uri === 'string') {
            try {
              const u = new URL(g.uri.startsWith('http') ? g.uri : `https://${g.uri}`)
              domain = normalizeDomain(u.hostname)
            } catch {
              const titleMatch = typeof g.title === 'string' ? g.title.match(/[a-z0-9-]+\.[a-z]{2,}/i) : null
              if (titleMatch) domain = normalizeDomain(titleMatch[0])
            }
          }
          if (!domain || seen.has(domain)) continue
          seen.add(domain)
          tSlots++
          totalGroundingSlots++
          if (domainBelongsTo(domain, projectDomains)) {
            pSlots++
            projectGroundingSlots++
          } else if (competitorDomains.length > 0 && domainBelongsTo(domain, competitorDomains)) {
            cSlots++
            competitorGroundingSlots++
          }
        }
        const cited = JSON.parse(snap.cited_domains || '[]') as string[]
        for (const d of cited) {
          totalCitedSlots++
          if (domainBelongsTo(d, projectDomains)) projectCitedSlots++
          else if (competitorDomains.length > 0 && domainBelongsTo(d, competitorDomains)) competitorCitedSlots++
        }
      }
      const share = tSlots > 0 ? (pSlots / tSlots) * 100 : 0
      perProviderRetrievalShare.push({ key, share, slots: tSlots })
      stats.withGrounding // keep ref; eslint no-unused
    }

    const retrievalShareAggregate = totalGroundingSlots > 0 ? (projectGroundingSlots / totalGroundingSlots) * 100 : 0
    const competitorRetrievalShare = totalGroundingSlots > 0 ? (competitorGroundingSlots / totalGroundingSlots) * 100 : 0
    const otherRetrievalShare = Math.max(0, 100 - retrievalShareAggregate - competitorRetrievalShare)

    const currentSoV = totalCitedSlots > 0 ? (projectCitedSlots / totalCitedSlots) * 100 : 0
    const currentSoVCompetitor = totalCitedSlots > 0 ? (competitorCitedSlots / totalCitedSlots) * 100 : 0

    log(`**Aggregate Retrieval Share (proposed):** ${fmt(retrievalShareAggregate)}% (${projectGroundingSlots}/${totalGroundingSlots} grounding slots)`)
    log(`**Current SoV (cited-slot ratio, in production today):** ${fmt(currentSoV)}% (${projectCitedSlots}/${totalCitedSlots} cited slots)`)
    log(`**Difference:** ${fmt(retrievalShareAggregate - currentSoV, 1)} percentage points`)
    log()
    log(`**Per-provider Retrieval Share** (bias-corrected average: ${fmt(mean(perProviderRetrievalShare.filter(p => p.slots > 0).map(p => p.share)))}%):`)
    log()
    log('| Provider | Slots | Share |')
    log('|---|---|---|')
    for (const p of perProviderRetrievalShare.sort((a, b) => b.slots - a.slots)) {
      log(`| \`${p.key}\` | ${p.slots} | ${fmt(p.share)}% |`)
    }
    log()
    log(`**Breakdown:** project ${fmt(retrievalShareAggregate)}% / competitor ${fmt(competitorRetrievalShare)}% / other ${fmt(otherRetrievalShare)}%`)
    log(`**Current SoV breakdown:** project ${fmt(currentSoV)}% / competitor ${fmt(currentSoVCompetitor)}% / other ${fmt(Math.max(0, 100 - currentSoV - currentSoVCompetitor))}%`)
    log()

    // Tone classification under proposed bands (≥15 pos, 5-14 caution, <5 neg)
    const toneNew = retrievalShareAggregate >= 15 ? 'positive' : retrievalShareAggregate >= 5 ? 'caution' : 'negative'
    const toneOld = currentSoV >= 30 ? 'positive' : currentSoV >= 10 ? 'caution' : 'negative'
    log(`**Tone under proposed bands (≥15 pos, 5-14 caution, <5 neg):** ${toneNew}`)
    log(`**Tone under current SoV bands (≥30 pos, 10-29 caution, <10 neg):** ${toneOld}`)
    log()

    // ─── D. Mention Share simulation ───
    log(`### D. Mention Share simulation`)
    log()
    let projectMentionSnapshots = 0
    const competitorMentionSnapshots = new Map<string, number>()
    let snapshotsWithAnswerText = 0

    for (const snap of latestSnapshots) {
      const text = snap.answer_text ?? ''
      if (text.length === 0) continue
      snapshotsWithAnswerText++
      if (snap.answer_mentioned === 1) projectMentionSnapshots++
      for (const cd of competitorDomains) {
        for (const tok of brandTokensFromDomain(cd)) {
          if (looksLikeBrandMention(text, tok)) {
            competitorMentionSnapshots.set(cd, (competitorMentionSnapshots.get(cd) ?? 0) + 1)
            break
          }
        }
      }
    }
    const totalCompetitorMentions = [...competitorMentionSnapshots.values()].reduce((a, b) => a + b, 0)
    const mentionShareDenom = projectMentionSnapshots + totalCompetitorMentions
    const mentionShare = mentionShareDenom > 0 ? (projectMentionSnapshots / mentionShareDenom) * 100 : 0

    log(`**Snapshots with answer text:** ${snapshotsWithAnswerText} / ${latestSnapshots.length} (${pct(snapshotsWithAnswerText, latestSnapshots.length, 0)})`)
    log(`**Project brand mentions:** ${projectMentionSnapshots} snapshots`)
    log(`**Competitor brand mentions:** ${totalCompetitorMentions} snapshots across ${competitorMentionSnapshots.size} competitors`)
    log(`**Mention Share (proposed):** ${fmt(mentionShare)}% (${projectMentionSnapshots}/${mentionShareDenom})`)
    log()
    if (competitorMentionSnapshots.size > 0) {
      log('Per-competitor breakdown:')
      log('| Competitor | Mention snapshots | Share of competitive total |')
      log('|---|---|---|')
      const sorted = [...competitorMentionSnapshots.entries()].sort((a, b) => b[1] - a[1])
      for (const [c, n] of sorted) {
        log(`| ${c} | ${n} | ${pct(n, totalCompetitorMentions, 1)} |`)
      }
      log()
    } else {
      log('_No competitor mentions detected in answer text._')
      log()
    }

    // ─── E. GSC source candidate volume ───
    log(`### E. GSC source — candidate volume`)
    log()
    const gscRows = db.prepare(`
      SELECT query, SUM(impressions) AS imp,
             AVG(CAST(position AS REAL)) AS pos,
             COUNT(DISTINCT date) AS day_count,
             MIN(date) AS first_seen, MAX(date) AS last_seen
      FROM gsc_search_data
      WHERE project_id = ? AND date >= date('now', '-${args.lookbackDays} days')
      GROUP BY query
      HAVING imp >= ?
      ORDER BY imp DESC
    `).all(project.id, args.minImpressions) as Array<{
      query: string; imp: number; pos: number; day_count: number; first_seen: string; last_seen: string
    }>

    log(`GSC rows in last ${args.lookbackDays} days, ≥${args.minImpressions} impressions: **${gscRows.length}**`)
    if (gscRows.length === 0) {
      log()
      log('_No GSC data — project may not have GSC connected or recent sync missing._')
      log()
    } else {
      // Filter: not tracked + not brand
      const trackedNorm = new Set(trackedQueries.map(q => normalizeQuery(q.query)))
      let trackedFilter = 0
      let jaccardFilter = 0
      let brandFilter = 0
      const candidates: typeof gscRows = []
      for (const row of gscRows) {
        const n = normalizeQuery(row.query)
        if (trackedNorm.has(n)) { trackedFilter++; continue }
        const ts = tokenSet(row.query)
        const hit = trackedTokenSets.find(t => jaccard(ts, t) >= 0.9)
        if (hit) { jaccardFilter++; continue }
        const isBrand = brandTokens.some(b => looksLikeBrandMention(row.query, b))
        if (isBrand) { brandFilter++; continue }
        candidates.push(row)
      }
      log(`Filtered out: ${trackedFilter} exact-tracked, ${jaccardFilter} Jaccard ≥0.9, ${brandFilter} pure-brand`)
      log(`**Survivors:** ${candidates.length} candidates`)
      log()
      const confidence = (imp: number, days: number): string => {
        if (imp >= 100 && days >= 5) return 'high'
        if (imp >= 30 && days >= 3) return 'medium'
        return 'low'
      }
      const byConf = { high: 0, medium: 0, low: 0 }
      for (const c of candidates) {
        const t = confidence(c.imp, c.day_count) as keyof typeof byConf
        byConf[t]++
      }
      log(`Confidence distribution: ${byConf.high} high · ${byConf.medium} medium · ${byConf.low} low`)
      log()
      log('Top 15 GSC candidates:')
      log('| Query | Imp | Pos | Days | Confidence |')
      log('|---|---|---|---|---|')
      for (const c of candidates.slice(0, 15)) {
        log(`| ${c.query} | ${c.imp} | ${fmt(c.pos)} | ${c.day_count} | ${confidence(c.imp, c.day_count)} |`)
      }
      log()
    }

    // ─── F. Snapshot mining ───
    log(`### F. Snapshot mining — candidate volume`)
    log()
    const recentRunsForMining = db.prepare(`
      SELECT id FROM runs
      WHERE project_id = ? AND kind = 'answer-visibility' AND status IN ('completed', 'partial')
        AND created_at >= datetime('now', '-90 days')
      ORDER BY created_at DESC
    `).all(project.id) as Array<{ id: string }>
    const miningRunIds = recentRunsForMining.map(r => r.id)
    if (miningRunIds.length === 0) {
      log('_No recent runs to mine._')
      log()
    } else {
      const miningPlaceholders = miningRunIds.map(() => '?').join(',')
      const miningSnapshots = db.prepare(`
        SELECT raw_response, query_id FROM query_snapshots
        WHERE run_id IN (${miningPlaceholders}) AND raw_response IS NOT NULL
      `).all(...miningRunIds) as Array<{ raw_response: string; query_id: string | null }>

      const queryById = new Map(trackedQueries.map(q => [normalizeQuery(q.query), q.query]))
      const queryRows = db.prepare('SELECT id, query FROM queries WHERE project_id = ?').all(project.id) as Array<{ id: string; query: string }>
      const queryNameById = new Map(queryRows.map(q => [q.id, q.query]))

      const accumulator = new Map<string, { count: number; sourceQueries: Set<string>; display: string }>()
      for (const snap of miningSnapshots) {
        const envelope = safeJson(snap.raw_response)
        const queries = Array.isArray(envelope.searchQueries) ? envelope.searchQueries : []
        const sourceQueryText = snap.query_id ? queryNameById.get(snap.query_id) : undefined
        for (const q of queries) {
          if (typeof q !== 'string' || q.trim().length === 0) continue
          const n = normalizeQuery(q)
          if (queryById.has(n)) continue // exact tracked
          const ts = tokenSet(q)
          const hit = trackedTokenSets.find(t => jaccard(ts, t) >= 0.9)
          if (hit) continue
          if (brandTokens.some(b => looksLikeBrandMention(q, b))) continue
          if (ts.size < 2) continue // too short / stop-word
          const entry = accumulator.get(n) ?? { count: 0, sourceQueries: new Set(), display: q }
          entry.count++
          if (sourceQueryText) entry.sourceQueries.add(sourceQueryText)
          accumulator.set(n, entry)
        }
      }
      const ranked = [...accumulator.values()].sort((a, b) => b.count - a.count)
      log(`Mined from ${miningSnapshots.length} snapshots across ${miningRunIds.length} runs`)
      log(`**Distinct candidates after filters:** ${ranked.length}`)
      log()
      log('Frequency distribution:')
      log(`- ≥5 occurrences: ${ranked.filter(r => r.count >= 5).length}`)
      log(`- 3-4 occurrences: ${ranked.filter(r => r.count >= 3 && r.count < 5).length}`)
      log(`- 2 occurrences: ${ranked.filter(r => r.count === 2).length}`)
      log(`- 1 occurrence: ${ranked.filter(r => r.count === 1).length}`)
      log()
      log('Top 15 snapshot-mined candidates:')
      log('| Query | Occurrences | From your queries |')
      log('|---|---|---|')
      for (const r of ranked.slice(0, 15)) {
        const srcLabel = [...r.sourceQueries].slice(0, 2).join(' / ') + (r.sourceQueries.size > 2 ? ` +${r.sourceQueries.size - 2} more` : '')
        log(`| ${r.display} | ${r.count} | ${srcLabel || '(unknown)'} |`)
      }
      log()
    }

    // ─── G. Hybrid overlap ───
    log(`### G. Hybrid overlap`)
    log()
    if (gscRows.length === 0 || miningRunIds.length === 0) {
      log('_Cannot compute overlap — one source has no data._')
      log()
    } else {
      // Re-derive both candidate lists (simplified — could share state above)
      const trackedNorm = new Set(trackedQueries.map(q => normalizeQuery(q.query)))
      const gscCanon = new Set<string>()
      for (const row of gscRows) {
        const n = normalizeQuery(row.query)
        if (trackedNorm.has(n)) continue
        const ts = tokenSet(row.query)
        if (trackedTokenSets.find(t => jaccard(ts, t) >= 0.9)) continue
        if (brandTokens.some(b => looksLikeBrandMention(row.query, b))) continue
        gscCanon.add(n)
      }
      const miningPlaceholders = miningRunIds.map(() => '?').join(',')
      const miningSnapshots = db.prepare(`SELECT raw_response FROM query_snapshots WHERE run_id IN (${miningPlaceholders}) AND raw_response IS NOT NULL`).all(...miningRunIds) as Array<{ raw_response: string }>
      const snapCanon = new Set<string>()
      for (const snap of miningSnapshots) {
        const envelope = safeJson(snap.raw_response)
        const queries = Array.isArray(envelope.searchQueries) ? envelope.searchQueries : []
        for (const q of queries) {
          if (typeof q !== 'string') continue
          const n = normalizeQuery(q)
          if (trackedNorm.has(n)) continue
          const ts = tokenSet(q)
          if (trackedTokenSets.find(t => jaccard(ts, t) >= 0.9)) continue
          if (brandTokens.some(b => looksLikeBrandMention(q, b))) continue
          if (ts.size < 2) continue
          snapCanon.add(n)
        }
      }
      const overlap = [...gscCanon].filter(q => snapCanon.has(q))
      log(`GSC-only candidates: ${[...gscCanon].filter(q => !snapCanon.has(q)).length}`)
      log(`Snapshot-only candidates: ${[...snapCanon].filter(q => !gscCanon.has(q)).length}`)
      log(`Corroborated by both: ${overlap.length}`)
      log(`Total unique hybrid candidates: ${new Set([...gscCanon, ...snapCanon]).size}`)
      log()
      if (overlap.length > 0) {
        log('Sample corroborated candidates:')
        for (const q of overlap.slice(0, 10)) {
          log(`- ${q}`)
        }
        log()
      }
    }

    log('---')
  }

  db.close()

  const report = out.join('\n')
  if (args.out) {
    fs.writeFileSync(args.out, report, 'utf-8')
    console.error(`Report written to ${args.out}`)
  } else {
    console.log(report)
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Some envelopes nest the API response one level down. Look for searchQueries / groundingSources at either level.
      const top = parsed as Record<string, unknown>
      if (top.searchQueries || top.groundingSources) return top
      if (top.apiResponse && typeof top.apiResponse === 'object') {
        // Some snapshots store grounding inside apiResponse
        const inner = top.apiResponse as Record<string, unknown>
        return { ...top, groundingSources: top.groundingSources ?? inner.groundingSources, searchQueries: top.searchQueries ?? inner.searchQueries }
      }
      return top
    }
    return {}
  } catch {
    return {}
  }
}

main()
