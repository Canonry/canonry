import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { competitors, projects, type DatabaseClient } from '@ainyc/canonry-db'
import {
  compareText,
  competitorIdentityAliases,
  effectiveBrandNames,
  effectiveDomains,
  type CompetitorIdentityInput,
} from '@ainyc/canonry-contracts'
import { competitorIdentityColumns } from './competitor-writes.js'
import { readMarketCompetitorNames } from './market-competitor-names.js'

/**
 * THE IDENTITY A STORED ANSWER IS SCORED AGAINST.
 *
 * Every per-snapshot field derived from answer text (`answer_mentioned`,
 * `competitor_overlap`, `recommended_competitors`) is a function of the stored
 * answer and the project's live identity: its domains and brand names, every
 * competitor's domain and names (curated plus auto-detected, minus blocked),
 * and the names learned for competitors only an Advanced market pins
 * (`readMarketCompetitorNames`). Plan pins themselves come from the run's own
 * immutable plan revision, so they are not part of it. A sweep scores with the identity it read when it
 * started, and a recompute with the identity it read when it ran; the
 * fingerprints say whether two of those readings could score an answer
 * differently:
 * - a chunked recompute re-reads it between chunks and never writes a chunk
 *   computed from an identity a newer change replaced
 *   (`backfillProjectAnswerMentionsInChunks`, `src/snapshot-competitor-refresh.ts`);
 * - a sweep, fill or batch ingest compares the identity it scored with
 *   against the current one after its last write, and rescores its run when
 *   they differ (`JobRunner.reconcileRunAnswerFields` in packages/canonry).
 */
export interface AnswerIdentity {
  projectDomains: string[]
  projectBrandNames: string[]
  /** Stored competitors with every name they answer to, in the order read (by domain). */
  competitors: CompetitorIdentityInput[]
  /** Learned names of market-only pins, by registrable domain (`createRunCompetitorResolver`'s third argument). */
  marketNames: Map<string, string[]>
  fingerprint: AnswerIdentityFingerprint
}

/**
 * Hashes of what scoring reads, split by what a change invalidates: `project`
 * feeds `answer_mentioned` and the competitor fields, `competitors` (market
 * names included) only the competitor fields. Equal fingerprints score every
 * stored answer the same.
 */
export interface AnswerIdentityFingerprint {
  project: string
  competitors: string
}

type IdentityProject = Pick<typeof projects.$inferSelect, 'canonicalDomain' | 'ownedDomains' | 'displayName' | 'aliases'>

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The identity of rows already read (a sweep passes the rows it scores with). */
export function answerIdentityFrom(
  project: IdentityProject,
  competitorRows: readonly CompetitorIdentityInput[],
  marketNames: ReadonlyMap<string, readonly string[]> = new Map(),
): AnswerIdentity {
  const projectDomains = effectiveDomains({ canonicalDomain: project.canonicalDomain, ownedDomains: project.ownedDomains })
  const projectBrandNames = effectiveBrandNames({ displayName: project.displayName, aliases: project.aliases })
  const names = competitorRows
    .map(row => [row.domain, competitorIdentityAliases(row)] as const)
    .sort(([left], [right]) => compareText(left, right))
  const market = [...marketNames]
    .map(([domain, learned]): [string, string[]] => [domain, [...learned]])
    .sort(([left], [right]) => compareText(left, right))
  return {
    projectDomains,
    projectBrandNames,
    competitors: [...competitorRows],
    marketNames: new Map(market.map(([domain, learned]) => [domain, learned])),
    fingerprint: {
      project: hash([projectDomains, projectBrandNames]),
      competitors: hash(market.length > 0 ? [names, market] : names),
    },
  }
}

/** The project's current identity, or null when the project is gone. */
export function readAnswerIdentity(db: Pick<DatabaseClient, 'select'>, projectId: string): AnswerIdentity | null {
  const project = db.select({
    canonicalDomain: projects.canonicalDomain,
    ownedDomains: projects.ownedDomains,
    displayName: projects.displayName,
    aliases: projects.aliases,
  }).from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return null
  const rows = db.select(competitorIdentityColumns)
    .from(competitors)
    .where(eq(competitors.projectId, projectId))
    .orderBy(competitors.domain)
    .all()
  return answerIdentityFrom(project, rows, readMarketCompetitorNames(db, projectId))
}

/** True when two identity readings could score some stored answer differently. */
export function answerIdentityChanged(before: AnswerIdentityFingerprint, after: AnswerIdentityFingerprint): boolean {
  return before.project !== after.project || before.competitors !== after.competitors
}
