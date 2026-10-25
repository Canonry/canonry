import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { SeoAdapterReceipt, SeoAdapterRequest, SeoAdapterResult, SeoProfileInput, SeoRunStatus, StoredSeoResults } from '@canonry/canonry-contracts'
import { projects, runs } from './schema.js'

export interface SeoBudgetBucket { scope: string; period: string; limit: number }
export const seoProfiles = sqliteTable('seo_profiles', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  id: text('id').notNull(), revision: integer('revision').notNull(),
  input: text('input', { mode: 'json' }).$type<SeoProfileInput>().notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [primaryKey({ columns: [t.projectId, t.id] })])

// Financial liabilities survive deletion of their user-facing project or run.
export const seoJobs = sqliteTable('seo_jobs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectKey: text('project_key').notNull(),
  runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
  profileId: text('profile_id').notNull(), profileRevision: integer('profile_revision').notNull(),
  profile: text('profile', { mode: 'json' }).$type<SeoProfileInput>().notNull(),
  scopeSnapshot: text('scope_snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  requestHash: text('request_hash').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  principalId: text('principal_id').notNull(), connectionId: text('connection_id').notNull(),
  accountKey: text('account_key').notNull(),
  buckets: text('buckets', { mode: 'json' }).$type<SeoBudgetBucket[]>().notNull(),
  status: text('status').$type<SeoRunStatus>().notNull(),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(), startedAt: text('started_at'), finishedAt: text('finished_at'), error: text('error'),
}, t => [uniqueIndex('idx_seo_jobs_idempotency').on(t.projectKey, t.idempotencyKey), index('idx_seo_jobs_intent').on(t.projectKey, t.requestHash), index('idx_seo_jobs_project').on(t.projectId, t.createdAt), index('idx_seo_jobs_run').on(t.runId), index('idx_seo_jobs_status').on(t.status)])
export const seoTasks = sqliteTable('seo_tasks', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull().references(() => seoJobs.id),
  request: text('request', { mode: 'json' }).$type<SeoAdapterRequest>().notNull(),
  status: text('status').$type<SeoRunStatus>().notNull(),
  leaseOwner: text('lease_owner'), leaseUntil: text('lease_until'),
  catalogRevision: text('catalog_revision').notNull(),
  collectionOutcome: text('collection_outcome').$type<SeoAdapterResult['outcome']>(),
  reservedMicros: integer('reserved_micros').notNull(), actualMicros: integer('actual_micros'),
  receipts: text('receipts', { mode: 'json' }).$type<SeoAdapterReceipt[]>().notNull().default([]),
  results: text('results', { mode: 'json' }).$type<StoredSeoResults>().notNull(),
  reconciliation: text('reconciliation', { mode: 'json' }).$type<{ actualCostMicros: number; remoteTaskId: string; outcome: 'completed' | 'failed'; note: string }>(),
  startedAt: text('started_at'), finishedAt: text('finished_at'), error: text('error'),
}, t => [index('idx_seo_tasks_job').on(t.jobId)])
export const seoBudgets = sqliteTable('seo_budgets', {
  scope: text('scope').notNull(), period: text('period').notNull(),
  reservedMicros: integer('reserved_micros').notNull().default(0), spentMicros: integer('spent_micros').notNull().default(0),
}, t => [primaryKey({ columns: [t.scope, t.period] })])
