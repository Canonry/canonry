import type { DatabaseClient } from '@ainyc/canonry-db'
import { competitorAliasProjectIdentity } from '@ainyc/canonry-contracts'
import { answerIdentityChanged, readAnswerIdentity, type AnswerIdentityFingerprint } from './answer-identity.js'
import { replanCompetitorAutoAliases, type CompetitorSetPlan } from './competitor-writes.js'
import { marketNameAuditFields, marketNameChanges, type MarketNameChange } from './market-competitor-names.js'
import { readMarketCompetitorPins } from './plan-competitors.js'

/**
 * WHAT A MARKET PIN WRITE DOES TO ANSWER-DERIVED NAMES.
 *
 * A pin of the active revision or the pending draft claims its names against
 * every answer-derived name of another domain (`readMarketCompetitorPins`):
 * the Advanced landscape counts both kinds of pin with the tracked
 * competitors, so a name a pin and an auto name share would credit one answer
 * twice. The two kinds of answer-derived name yield to a pin write the same
 * way:
 * - a tracked competitor's stored auto name is dropped inside the pin write's
 *   transaction and audited on its row (`replanCompetitorAutoAliases`);
 * - a name learned for a market-only pin follows at read time
 *   (`readMarketCompetitorNames`), and comes back when the pin goes (a discard,
 *   a publish that drops it, a deactivation). The writer compares those
 *   names before and after the write and audits the difference on its row
 *   (`marketNameChanges`), so `competitorIdentityChangedAt` moves with them.
 * Either way the identity stored answers are scored with
 * (`readAnswerIdentity`) can change, so the writer compares it before and
 * after the write and asks for the competitor-fields recompute
 * (`onCompetitorAliasesChanged`) when it moved, and asks for a detection
 * pass (`onCompetitorAutoAliasRescan`) when the pins moved, since a released
 * name may be learned again.
 *
 * Pin writers: the draft `pin-competitor` route, every draft action, draft
 * publish and discard, plan deactivation and the legacy v1
 * `PUT /measurement-plan`. Writers that never change a pin (group membership,
 * discovery commits, query-tracking publishes) are not wrapped.
 */
export interface MarketPinWriteEffect extends Pick<CompetitorSetPlan, 'autoAliasChanges' | 'droppedAutoAliases'> {
  /** The identity stored answers are scored with changed: recompute their competitor fields. */
  identityChanged: boolean
  /** The market pins changed: a name a removed pin held may be learned again. */
  pinsChanged: boolean
  /** Learned names of market-only pins the write claimed, released or dropped. */
  marketNameChanges: MarketNameChange[]
}

export interface MarketPinWriteHooks {
  onCompetitorAliasesChanged?: (projectId: string, projectName: string) => void
  onCompetitorAutoAliasRescan?: (projectId: string, projectName: string) => void
}

type PinWriteTx = Pick<DatabaseClient, 'select' | 'update'>
type PinWriteProject = Parameters<typeof competitorAliasProjectIdentity>[0] & { id: string }

/**
 * Call inside the pin writer's transaction BEFORE it writes; call `finish`
 * after the write, before the writer's audit row (its fields go on that row).
 */
export function beginMarketPinWrite(tx: PinWriteTx, project: PinWriteProject): { finish(): MarketPinWriteEffect } {
  const before = readAnswerIdentity(tx, project.id)
  const identityBefore: AnswerIdentityFingerprint | null = before?.fingerprint ?? null
  const pinsBefore = JSON.stringify(readMarketCompetitorPins(tx, project.id))
  return {
    finish(): MarketPinWriteEffect {
      const replanned = replanCompetitorAutoAliases(tx, project.id, competitorAliasProjectIdentity(project))
      const after = readAnswerIdentity(tx, project.id)
      const identityAfter = after?.fingerprint ?? null
      return {
        ...replanned,
        identityChanged: identityBefore !== null && identityAfter !== null && answerIdentityChanged(identityBefore, identityAfter),
        pinsChanged: JSON.stringify(readMarketCompetitorPins(tx, project.id)) !== pinsBefore,
        marketNameChanges: before && after ? marketNameChanges(before.marketNames, after.marketNames) : [],
      }
    },
  }
}

/**
 * Audit-diff fields for the answer-derived names a pin write moved: tracked
 * competitors' auto names it dropped and market-only pins' learned names it
 * claimed, released or dropped. Empty when it moved none.
 */
export function marketPinWriteAuditFields(effect: MarketPinWriteEffect): Record<string, unknown> {
  return {
    ...(effect.autoAliasChanges.length ? { autoAliasChanges: effect.autoAliasChanges } : {}),
    ...(effect.droppedAutoAliases.length ? { droppedAutoAliases: effect.droppedAutoAliases } : {}),
    ...marketNameAuditFields(effect.marketNameChanges),
  }
}

/** After the pin write commits: ask the host for the recompute and the detection pass the write needs. */
export function notifyMarketPinWrite(
  hooks: MarketPinWriteHooks,
  project: { id: string; name: string },
  effect: MarketPinWriteEffect | null,
): void {
  if (!effect) return
  if (effect.identityChanged) hooks.onCompetitorAliasesChanged?.(project.id, project.name)
  if (effect.pinsChanged) hooks.onCompetitorAutoAliasRescan?.(project.id, project.name)
}
