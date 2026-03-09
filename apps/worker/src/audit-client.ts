import { runAeoAudit } from '@ainyc/aeo-audit'

export const auditClientDescriptor = {
  packageName: '@ainyc/aeo-audit',
  source: 'npm',
} as const

export function describeAuditClient(): string {
  return `${auditClientDescriptor.packageName} via ${auditClientDescriptor.source}`
}

export async function runTechnicalAudit(
  ...args: Parameters<typeof runAeoAudit>
): Promise<Awaited<ReturnType<typeof runAeoAudit>>> {
  return runAeoAudit(...args)
}
