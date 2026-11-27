import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, notifications, projects, runs, siteCrawlAttempts, siteCrawlPages, siteCrawlSnapshots, siteHealthNotifyState } from '@canonry/canonry-db'
import type { SiteHealthIssueWebhookPayload } from '@canonry/canonry-contracts'
import { Notifier } from '../src/notifier.js'

// What the audit engine stores per page: binary defects beside the factor scores.
type Defect = { id: string; severity: 'critical' | 'warning' }
const H1S: Defect = { id: 'multiple-h1', severity: 'critical' }
const OTHER_PROPERTY: Defect = { id: 'names-another-entity', severity: 'critical' }
const NO_DESCRIPTION: Defect = { id: 'missing-meta-description', severity: 'warning' }
const site = 'https://harborline.example.com'

function harness(events: string[] = ['site-health.issue.new']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-site-health-alerts-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example.com',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(notifications).values({
    id: crypto.randomUUID(), projectId, channel: 'webhook',
    config: { url: 'https://hooks.example/site-health', events },
    enabled: true, createdAt: now, updatedAt: now,
  } as never).run()
  const notifier = new Notifier(db, 'https://canonry.test')
  const sent: SiteHealthIssueWebhookPayload[] = []
  const accept = { value: true }
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    sent.push(args[1] as SiteHealthIssueWebhookPayload)
    return accept.value
  })
  let clock = Date.parse('2026-11-01T06:00:00.000Z')
  /** Store one audit run the way the site-audit executor does, and return its id. */
  const audit = (pages: Record<string, Defect[]>, opts: { complete?: boolean; status?: string; kind?: string } = {}): string => {
    const at = new Date(clock += 60_000).toISOString()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    db.insert(runs).values({ id: runId, projectId, kind: opts.kind ?? 'site-audit', status: opts.status ?? 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at } as never).run()
    db.insert(siteCrawlAttempts).values({ id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed', createdAt: at, updatedAt: at } as never).run()
    db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, attemptId, rootUrl: `${site}/`,
      complete: opts.complete ?? true, detailsAvailable: true, createdAt: at, updatedAt: at,
    } as never).run()
    for (const [pagePath, defects] of Object.entries(pages)) {
      db.insert(siteCrawlPages).values({
        id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey: pagePath, url: `${site}${pagePath}`, path: pagePath, parentPath: '/',
        auditFields: { schemaVersion: '1.0', factors: [], criticalDefects: defects.map(defect => ({ ...defect, detail: 'Found on this page.', recommendation: 'Fix it.' })) },
        createdAt: at, updatedAt: at,
      } as never).run()
    }
    return runId
  }
  const reportedKeys = () => db.select().from(siteHealthNotifyState).where(eq(siteHealthNotifyState.projectId, projectId)).get()?.reportedKeys ?? null
  return { db, projectId, notifier, sent, accept, audit, reportedKeys }
}

test('reports every current critical problem once, then stays quiet while nothing is new', async () => {
  const h = harness()
  const first = h.audit({ '/a/': [H1S, NO_DESCRIPTION], '/b/': [H1S], '/c/': [OTHER_PROPERTY], '/d/': [] })
  expect(await h.notifier.onSiteAuditCompleted(first, h.projectId)).toBe('site-health.issue.new')
  expect(h.sent).toEqual([{
    source: 'canonry',
    event: 'site-health.issue.new',
    project: { name: 'harborline', canonicalDomain: 'harborline.example.com' },
    run: { id: first, status: 'completed', finishedAt: '2026-11-01T06:01:00.000Z' },
    scanComplete: true,
    issues: [
      { code: 'multiple-h1', title: 'Multiple H1 tags', severity: 'critical', affectedPages: 2, newPages: 2, examples: [`${site}/a/`, `${site}/b/`] },
      { code: 'names-another-entity', title: 'Names another property', severity: 'critical', affectedPages: 1, newPages: 1, examples: [`${site}/c/`] },
    ],
    dashboardUrl: 'https://canonry.test/projects/harborline/technical-aeo',
  }])
  const again = h.audit({ '/a/': [H1S, NO_DESCRIPTION], '/b/': [H1S], '/c/': [OTHER_PROPERTY], '/d/': [] })
  expect(await h.notifier.onSiteAuditCompleted(again, h.projectId)).toBeNull()
  expect(h.sent).toHaveLength(1)
})

test('reports a known problem again only for the pages it newly reached', async () => {
  const h = harness()
  await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S], '/b/': [H1S] }), h.projectId)
  const pages = Object.fromEntries(['/a/', '/b/', '/c/', '/d/', '/e/', '/f/', '/g/', '/h/'].map(page => [page, [H1S]]))
  expect(await h.notifier.onSiteAuditCompleted(h.audit(pages), h.projectId)).toBe('site-health.issue.new')
  expect(h.sent.at(-1)?.issues).toEqual([{
    code: 'multiple-h1', title: 'Multiple H1 tags', severity: 'critical', affectedPages: 8, newPages: 6,
    // At most five examples, sorted, and only new pages.
    examples: ['/c/', '/d/', '/e/', '/f/', '/g/'].map(page => `${site}${page}`),
  }])
})

test('a partial scan never clears a problem; a complete scan does, so a comeback is reported', async () => {
  const h = harness()
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBe('site-health.issue.new')
  const reported = h.reportedKeys()
  expect(reported).toHaveLength(1)
  // The partial scan did not reach /a/; it must not forget the problem there.
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/b/': [] }, { complete: false, status: 'partial' }), h.projectId)).toBeNull()
  expect(h.reportedKeys()).toEqual(reported)
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBeNull()
  // A complete scan that no longer finds it clears it...
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [] }), h.projectId)).toBeNull()
  expect(h.reportedKeys()).toEqual([])
  // ...so it is reported again when it comes back.
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBe('site-health.issue.new')
  expect(h.sent).toHaveLength(2)
})

test('a partial scan reports what it found, says the scan was partial, and keeps what it did not reach', async () => {
  const h = harness()
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBe('site-health.issue.new')
  // The partial scan reached /b/ but not /a/.
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/b/': [OTHER_PROPERTY] }, { complete: false, status: 'partial' }), h.projectId)).toBe('site-health.issue.new')
  expect(h.sent[1]).toMatchObject({ scanComplete: false, run: { status: 'partial' }, issues: [{ code: 'names-another-entity', newPages: 1 }] })
  expect(h.reportedKeys()).toHaveLength(2)
  // So the next complete scan finds nothing new on /a/ either.
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S], '/b/': [OTHER_PROPERTY] }), h.projectId)).toBeNull()
  expect(h.sent).toHaveLength(2)
})

test('an alert no webhook accepted is owed after the next audit', async () => {
  const h = harness()
  h.accept.value = false
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBeNull()
  expect(h.sent).toHaveLength(1)
  expect(h.reportedKeys()).toBeNull()
  h.accept.value = true
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBe('site-health.issue.new')
  expect(h.sent).toHaveLength(2)
  expect(h.sent[1]?.issues[0]).toMatchObject({ code: 'multiple-h1', newPages: 1 })
})

test('only webhooks that list the event receive it, and nothing is recorded without one', async () => {
  const h = harness(['run.completed', 'health.degraded'])
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }), h.projectId)).toBeNull()
  expect(h.sent).toEqual([])
  expect(h.reportedKeys()).toBeNull()
})

test('ignores warnings, failed audits and other run kinds', async () => {
  const h = harness()
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [NO_DESCRIPTION] }), h.projectId)).toBeNull()
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }, { status: 'failed' }), h.projectId)).toBeNull()
  expect(await h.notifier.onSiteAuditCompleted(h.audit({ '/a/': [H1S] }, { kind: 'answer-visibility' }), h.projectId)).toBeNull()
  expect(h.sent).toEqual([])
})
