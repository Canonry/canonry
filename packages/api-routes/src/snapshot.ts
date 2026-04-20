import type { FastifyInstance } from 'fastify'
import { internalError, notImplemented, snapshotRequestSchema, validationError, type SnapshotReportDto, type SnapshotRequestDto } from '@ainyc/canonry-contracts'

export interface SnapshotRoutesOptions {
  onSnapshotRequested?: (input: SnapshotRequestDto) => Promise<SnapshotReportDto>
}

export async function snapshotRoutes(app: FastifyInstance, opts: SnapshotRoutesOptions) {
  app.post<{
    Body: SnapshotRequestDto
  }>('/snapshot', async (request) => {
    const parsed = snapshotRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid snapshot payload', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    if (!opts.onSnapshotRequested) {
      throw notImplemented('Snapshot reporting is not supported in this deployment')
    }

    try {
      return await opts.onSnapshotRequested(parsed.data)
    } catch (err) {
      request.log.error({ err }, 'Snapshot report generation failed')
      throw internalError(err instanceof Error ? err.message : 'Failed to generate snapshot report')
    }
  })
}
