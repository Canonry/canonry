import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import {
  createClient,
  migrate,
  notifications,
  projects,
  queries,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'

// Regression suite for #480 fan-out behavior in the citation-change notifier.
// The pre-#480 logic compared `runs[0]` vs `runs[1]` for the run-completed
// webhook, which under --all-locations fan-out compared the sibling location's
// CURRENT run as if it were "previous" — firing spurious citation.lost /
// citation.gained events on every multi-location sweep.

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-notifier-fanout-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

interface RunSpec {
  id: string
  location: string | null
  createdAt: string
  status: 'completed' | 'partial' | 'queued' | 'running' | 'failed' | 'cancelled'
}

interface SnapSpec {
  runId: string
  queryId: string
  provider: string
  location: string | null
  citationState: 'cited' | 'not-cited'
}

function seedFanOutScenario(opts: { currentSiblingStatus?: RunSpec['status'] } = {}) {
  const db = buildDb()
  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const prevCreatedAt = '2026-05-12T17:23:20.060Z'
  const latestCreatedAt = '2026-05-13T17:23:20.060Z'

  // IDs chosen so michigan's id is greater than florida's — the pre-fix code
  // would have picked michigan as the "representative." Under the corrected
  // last-to-finish gate, the choice depends purely on completion order.
  const prevFlId = '00000000-0000-0000-0000-000000000001'
  const prevMiId = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
  const latestFlId = '00000000-0000-0000-0000-000000000002'
  const latestMiId = 'ffffffff-ffff-ffff-ffff-fffffffffff2'

  db.insert(projects).values({
    id: projectId,
    name: 'azcoatings',
    displayName: 'AZ Coatings',
    canonicalDomain: 'azcoatings.example',
    country: 'US',
    language: 'en',
    ownedDomains: '[]',
    tags: '[]',
    providers: '[]',
    locations: JSON.stringify([
      { label: 'florida',  city: 'Orlando', region: 'Florida',  country: 'US' },
      { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
    ]),
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: latestCreatedAt,
  }).run()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'polyurea roof coating',
    createdAt: '2026-05-10T00:00:00.000Z',
  }).run()

  const runSpecs: RunSpec[] = [
    { id: prevFlId,   location: 'florida',  createdAt: prevCreatedAt,   status: 'completed' },
    { id: prevMiId,   location: 'michigan', createdAt: prevCreatedAt,   status: 'completed' },
    { id: latestFlId, location: 'florida',  createdAt: latestCreatedAt, status: 'completed' },
    { id: latestMiId, location: 'michigan', createdAt: latestCreatedAt, status: opts.currentSiblingStatus ?? 'completed' },
  ]
  db.insert(runs).values(runSpecs.map(r => ({
    id: r.id,
    projectId,
    kind: 'answer-visibility' as const,
    status: r.status,
    trigger: 'manual',
    location: r.location,
    createdAt: r.createdAt,
    finishedAt: r.status === 'completed' || r.status === 'partial' ? r.createdAt : null,
  }))).run()

  // Previous group: cited at florida, cited at michigan.
  // Latest group: cited at florida (no change), NOT cited at michigan (regression).
  const snaps: SnapSpec[] = [
    { runId: prevFlId,   queryId, provider: 'gemini', location: 'florida',  citationState: 'cited' },
    { runId: prevMiId,   queryId, provider: 'gemini', location: 'michigan', citationState: 'cited' },
    { runId: latestFlId, queryId, provider: 'gemini', location: 'florida',  citationState: 'cited' },
    { runId: latestMiId, queryId, provider: 'gemini', location: 'michigan', citationState: 'not-cited' },
  ]
  db.insert(querySnapshots).values(snaps.map(s => ({
    id: crypto.randomUUID(),
    runId: s.runId,
    queryId: s.queryId,
    provider: s.provider,
    citationState: s.citationState,
    answerMentioned: s.citationState === 'cited',
    location: s.location,
    citedDomains: s.citationState === 'cited' ? ['azcoatings.example'] : [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    rawResponse: '{}',
    createdAt: s.runId.includes('latest') ? '2026-05-13T17:23:21.000Z' : '2026-05-12T17:23:21.000Z',
  }))).run()

  return { db, projectId, prevFlId, prevMiId, latestFlId, latestMiId }
}

// computeTransitions is a private method; tests reach it via cast.
function callCompute(notifier: Notifier, runId: string, projectId: string) {
  return (notifier as unknown as {
    computeTransitions: (runId: string, projectId: string) => Array<{
      query: string; from: string; to: string; provider: string; location: string | null
    }>
  }).computeTransitions(runId, projectId)
}

function callListEnabledNotifications(notifier: Notifier, projectId: string) {
  return (notifier as unknown as {
    listEnabledNotifications: (projectId: string) => Array<{ id: string; projectId: string | null }>
  }).listEnabledNotifications(projectId)
}

describe('Notifier multi-location fan-out (#480)', () => {
  it('returns no transitions while a sibling run is still pending', () => {
    // michigan still running when florida fires its onRunCompleted →
    // wait, don't fire. Pre-fix code would have produced a cross-location
    // diff (comparing florida-current to michigan-current at the prior
    // group, which is exactly the bug).
    const { db, projectId, latestFlId } = seedFanOutScenario({ currentSiblingStatus: 'running' })
    const notifier = new Notifier(db, 'http://localhost:4100')
    const transitions = callCompute(notifier, latestFlId, projectId)
    expect(transitions).toEqual([])
  })

  it('fires once with combined-group transitions after the last sibling finishes', () => {
    // Both florida and michigan are now completed. The last completion
    // (whichever happens to be processed) sees no siblings still pending,
    // looks up the previous distinct-createdAt group, and computes the
    // (query, provider, location) diff. Florida is unchanged (cited→cited)
    // and is correctly suppressed; michigan regressed (cited→not-cited) and
    // is reported as a transition.
    const { db, projectId, latestMiId } = seedFanOutScenario()
    const notifier = new Notifier(db, 'http://localhost:4100')
    const transitions = callCompute(notifier, latestMiId, projectId)

    // Exactly one transition — michigan's regression — not two.
    expect(transitions).toHaveLength(1)
    expect(transitions[0]).toEqual({
      query: 'polyurea roof coating',
      from: 'cited',
      to: 'not-cited',
      provider: 'gemini',
      location: 'michigan',
    })
  })

  it('compares against the previous fan-out group, never against the sibling location of the same group', () => {
    // Critical pre-fix bug: with limit(2) and identical timestamps in the
    // current group, recentRuns was [florida-latest, michigan-latest] and
    // the code treated michigan-latest as "previous" — producing spurious
    // florida↔michigan diffs as if they were time-series transitions.
    const { db, projectId, latestMiId } = seedFanOutScenario()
    const notifier = new Notifier(db, 'http://localhost:4100')
    const transitions = callCompute(notifier, latestMiId, projectId)

    // florida didn't change between the previous group and the latest
    // group, so it must not appear in transitions. If the fix regressed
    // and started comparing against the sibling-location run, we'd see
    // florida↔michigan flips here.
    expect(transitions.some(t => t.location === 'florida')).toBe(false)
  })

  it('only the winner (max finishedAt, tiebreak max id) fires; loser returns [] even when all siblings are done', () => {
    // This is the core dedup gate that makes the notifier safe against
    // async-dispatch races. Even when BOTH siblings have completed and a
    // delayed notifier event for the loser sees "all siblings finished",
    // the loser independently computes the winner and bails — guaranteeing
    // exactly one webhook fires per group regardless of dispatch ordering.
    const { db, projectId, latestFlId, latestMiId } = seedFanOutScenario()
    const notifier = new Notifier(db, 'http://localhost:4100')

    // florida has the lex-lesser id ('0000...0002'); michigan's id is
    // 'ffff...0002'. Both share the same finishedAt, so the id tiebreak
    // applies — michigan wins. Calling compute with florida (the loser)
    // must return [].
    const floridaTransitions = callCompute(notifier, latestFlId, projectId)
    expect(floridaTransitions).toEqual([])

    // michigan (the winner) computes the diff.
    const michiganTransitions = callCompute(notifier, latestMiId, projectId)
    expect(michiganTransitions.length).toBeGreaterThan(0)
  })

  it('does not block on a queued sibling of a different `kind`', () => {
    // A queued traffic-sync sharing the answer-visibility group's createdAt
    // millisecond must not block the answer-visibility webhook. The sibling
    // query is filtered by `kind` so cross-kind interference is impossible.
    const { db, projectId, latestMiId } = seedFanOutScenario()

    // Add a same-createdAt traffic-sync row in 'queued' state. Without the
    // kind filter, this would trigger the "still pending" early return and
    // suppress the answer-visibility webhook.
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'traffic-sync',
      status: 'queued',
      trigger: 'scheduled',
      location: null,
      createdAt: '2026-05-13T17:23:20.060Z',
      finishedAt: null,
    }).run()

    const notifier = new Notifier(db, 'http://localhost:4100')
    const transitions = callCompute(notifier, latestMiId, projectId)
    expect(transitions.length).toBeGreaterThan(0)
  })

  it('returns no transitions when the previous fan-out group is missing entirely', () => {
    // First-ever sweep of a multi-location project — only one fan-out
    // group exists, no previous to compare against.
    const db = buildDb()
    const projectId = crypto.randomUUID()
    const queryId = crypto.randomUUID()
    const latestFlId = crypto.randomUUID()
    const latestMiId = crypto.randomUUID()
    const latestCreatedAt = '2026-05-13T17:23:20.060Z'

    db.insert(projects).values({
      id: projectId,
      name: 'first-sweep',
      displayName: 'First Sweep',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      locations: '[]',
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: latestCreatedAt,
    }).run()
    db.insert(queries).values({
      id: queryId,
      projectId,
      query: 'q',
      createdAt: '2026-05-10T00:00:00.000Z',
    }).run()
    db.insert(runs).values([
      { id: latestFlId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  createdAt: latestCreatedAt, finishedAt: latestCreatedAt },
      { id: latestMiId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', createdAt: latestCreatedAt, finishedAt: latestCreatedAt },
    ]).run()
    db.insert(querySnapshots).values([
      { id: crypto.randomUUID(), runId: latestFlId, queryId, provider: 'gemini', citationState: 'cited', answerMentioned: true, location: 'florida',  citedDomains: ['example.com'], competitorOverlap: [], recommendedCompetitors: [], rawResponse: '{}', createdAt: latestCreatedAt },
      { id: crypto.randomUUID(), runId: latestMiId, queryId, provider: 'gemini', citationState: 'cited', answerMentioned: true, location: 'michigan', citedDomains: ['example.com'], competitorOverlap: [], recommendedCompetitors: [], rawResponse: '{}', createdAt: latestCreatedAt },
    ]).run()

    const notifier = new Notifier(db, 'http://localhost:4100')
    const transitions = callCompute(notifier, latestMiId, projectId)
    expect(transitions).toEqual([])
  })

  it('includes tenant-scoped notification subscribers for cloud bootstrap webhooks', () => {
    const { db, projectId } = seedFanOutScenario()
    const otherProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: otherProjectId,
      name: 'other-project',
      displayName: 'Other Project',
      canonicalDomain: 'other.example',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      locations: '[]',
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
    }).run()
    db.insert(notifications).values([
      {
        id: 'notif-project',
        projectId,
        channel: 'webhook',
        config: { url: 'https://example.com/project', events: ['run.completed'] },
        enabled: true,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'notif-tenant',
        projectId: null,
        channel: 'webhook',
        config: { url: 'https://example.com/tenant', events: ['run.completed'] },
        enabled: true,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'notif-other-project',
        projectId: otherProjectId,
        channel: 'webhook',
        config: { url: 'https://example.com/other', events: ['run.completed'] },
        enabled: true,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'notif-disabled-tenant',
        projectId: null,
        channel: 'webhook',
        config: { url: 'https://example.com/disabled', events: ['run.completed'] },
        enabled: false,
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
    ]).run()

    const notifier = new Notifier(db, 'http://localhost:4100')
    const ids = callListEnabledNotifications(notifier, projectId).map(n => n.id).sort()

    expect(ids).toEqual(['notif-project', 'notif-tenant'])
  })
})
