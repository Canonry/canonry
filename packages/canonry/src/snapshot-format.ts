import type { SnapshotAuditFactorDto } from '@ainyc/canonry-contracts'

export function formatAuditFactorScore(factor: Pick<SnapshotAuditFactorDto, 'score' | 'weight'>): string {
  return `${factor.score}/100 (${factor.weight}% weight)`
}
