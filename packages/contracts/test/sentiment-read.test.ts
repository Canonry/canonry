import { describe, expect, it } from 'vitest'
import { sentimentFixtureSummary } from './fixtures/sentiment.js'
import { emptySentimentCounts, sentimentJobSchema, sentimentSummarySchema, type SentimentJob } from '../src/sentiment.js'
import { sentimentJobReadSchema, sentimentJobsReadSchema, sentimentSummaryReadSchema } from '../src/sentiment-read.js'

const assessment = { assessmentId: 'assessment', sourceSnapshotId: 'snapshot', runId: 'run', subjectId: 'subject', subjectLabel: 'Subject', executionNodeKey: null, provider: 'openai', requestedModel: 'requested', servedModel: 'served', location: null, evaluationDefinitionId: 'definition', state: 'complete', outcome: 'favorable', reason: null }
const { state, reason, provisional, coverage, score } = sentimentFixtureSummary
const current = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, queries: [{ state, reason, provisional, coverage, score, queryId: 'query', queryText: 'Synthetic query', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], assessments: [assessment], locations: [] }] })
const job: SentimentJob = {
  id: 'job', projectId: 'project', origin: 'backfill', state: 'pending', enablementEpoch: 1, evaluationDefinitionId: 'definition',
  selection: { mode: 'auto', queryClass: 'non-brand', scope: 'project', runId: 'run' }, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  counts: { ...emptySentimentCounts(), pending: 2 }, selected: 2, cancellationReason: null, attempts: [],
}

/** What a newer server might send: a new field at several levels, a new state and outcome, and a count keyed by it. */
function newerSummary() {
  return {
    ...current, pageInfo: { next: null }, state: 'queued',
    coverage: { ...current.coverage, counts: { ...current.coverage.counts, 'legacy-missing-language': 2 }, languageSkipped: 2 },
    queries: current.queries.map(row => ({ ...row, nodeLabel: 'node', assessments: row.assessments.map(item => ({ ...item, outcome: 'subject-renamed', attempts: 1 })) })),
  }
}

describe('sentiment client readers', () => {
  it('read a newer server summary the strict DTO rejects, dropping unknown fields and keeping new values', () => {
    const newer = newerSummary()
    expect(sentimentSummarySchema.safeParse(newer).success).toBe(false)
    const read = sentimentSummaryReadSchema.parse(newer)
    expect(read).not.toHaveProperty('pageInfo')
    expect(read.coverage).not.toHaveProperty('languageSkipped')
    expect(read.queries[0]).not.toHaveProperty('nodeLabel')
    expect(read.queries[0]!.assessments[0]).not.toHaveProperty('attempts')
    expect(read.state).toBe('queued')
    expect(read.queries[0]!.assessments[0]!.outcome).toBe('subject-renamed')
    // A count keyed by a new outcome is kept, so the counts still add up to what was selected.
    expect(read.coverage.counts).toEqual({ ...current.coverage.counts, 'legacy-missing-language': 2 })
  })

  it('return a current response unchanged', () => {
    expect(sentimentSummaryReadSchema.parse(current)).toEqual(current)
    expect(sentimentJobReadSchema.parse(sentimentJobSchema.parse(job))).toEqual(job)
  })

  it('read jobs with a new job state, origin and outcome count', () => {
    const { attempts: _attempts, ...listed } = { ...job, attemptCount: 3 }
    const newer = { jobs: [{ ...listed, state: 'paused', origin: 'scheduled', counts: { ...job.counts, 'legacy-missing-language': 1 }, cost: 0 }], nextCursor: null }
    expect(sentimentJobsReadSchema.parse(newer)).toEqual({ jobs: [{ ...listed, state: 'paused', origin: 'scheduled', counts: { ...job.counts, 'legacy-missing-language': 1 } }] })
  })

  it('still reject a response that breaks a field it knows', () => {
    expect(sentimentSummaryReadSchema.safeParse({ ...current, coverage: { ...current.coverage, judged: -1 } }).success).toBe(false)
    expect(sentimentSummaryReadSchema.safeParse({ ...current, score: { ...current.score, favorableRate: 2 } }).success).toBe(false)
    const { counts: _counts, ...withoutCounts } = job
    expect(sentimentJobReadSchema.safeParse(withoutCounts).success).toBe(false)
  })
})
