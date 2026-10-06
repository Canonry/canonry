const auditClientDescriptor = {
  packageName: '@ainyc/aeo-audit',
  source: 'npm',
} as const

export function describeAuditClient(): string {
  return `${auditClientDescriptor.packageName} via ${auditClientDescriptor.source}`
}
