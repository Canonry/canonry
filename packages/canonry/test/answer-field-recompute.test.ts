import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { createAnswerFieldRecomputeQueue } from '../src/answer-field-recompute.js'

// The one queue every identity-change recompute of the stored answer fields
// goes through: competitor names changes recompute the competitor fields, a
// project alias change recomputes mentions too, and requests made during a
// pass share one follow-up pass with the widest scope.

const NOW = '2026-10-05T12:00:00.000Z'
const ANSWER = 'Top picks for bike repair:\n- **TuneSpoke**: fast quotes.\n- **Rotorwise**: strong reviews.'

function seeded() {
  const db: DatabaseClient = createClient(':memory:')
  onTestFinished(() => db.$client.close())
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({ id: projectId, name: 'rotorwise', displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(competitors).values({ id: 'spoke', projectId, domain: 'spoketuneworks.example', aliases: ['TuneSpoke'], createdAt: NOW }).run()
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: 'best bike repair shop', createdAt: NOW }).run()
  const runIds = ['run-a', 'run-b']
  for (const runId of runIds) {
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: NOW }).run()
    db.insert(querySnapshots).values({
      id: `${runId}-answer`, runId, queryId, provider: 'openai', citationState: 'not-cited',
      // Stale on purpose: what a run scored with an earlier identity stored.
      answerMentioned: false, answerText: ANSWER, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: NOW,
    }).run()
  }
  const row = (runId: string) => db.select().from(querySnapshots).where(eq(querySnapshots.id, `${runId}-answer`)).get()!
  return { db, projectId, row }
}

describe('createAnswerFieldRecomputeQueue', () => {
  it('recomputes only the competitor fields of every run for a competitor names change', async () => {
    const { db, projectId, row } = seeded()
    const queue = createAnswerFieldRecomputeQueue({ db })
    const pass = await queue.request(projectId, {})
    expect(pass).toMatchObject({ full: false, result: { examined: 2, updated: 2, mentioned: 0 } })
    for (const runId of ['run-a', 'run-b']) {
      expect(row(runId)).toMatchObject({ answerMentioned: false, competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] })
    }
  })

  it('recomputes mentions too for a project identity change', async () => {
    const { db, projectId, row } = seeded()
    const queue = createAnswerFieldRecomputeQueue({ db })
    await expect(queue.request(projectId, { full: true })).resolves.toMatchObject({ full: true, result: { examined: 2, updated: 2, mentioned: 2 } })
    expect([row('run-a').answerMentioned, row('run-b').answerMentioned]).toEqual([true, true])
  })

  it('folds requests made during a pass into one follow-up with the widest scope', async () => {
    const { db, projectId, row } = seeded()
    const queue = createAnswerFieldRecomputeQueue({ db })
    const first = queue.request(projectId, {})
    const during = [
      queue.request(projectId, {}),
      queue.request(projectId, { full: true }),
    ]
    await expect(first).resolves.toMatchObject({ full: false, result: { examined: 2, mentioned: 0 } })
    expect(row('run-a').answerMentioned).toBe(false)
    const [followUp, shared] = await Promise.all(during)
    expect(followUp).toBe(shared)
    expect(followUp).toMatchObject({ full: true, result: { examined: 2, mentioned: 2 } })
    expect([row('run-a').answerMentioned, row('run-b').answerMentioned]).toEqual([true, true])
  })
})
