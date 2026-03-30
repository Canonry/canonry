import type { FastifyInstance } from 'fastify'
import { notImplemented, snapshotRequestSchema, validationError, type SnapshotReportDto, type SnapshotRequestDto } from '@ainyc/canonry-contracts'

export interface SnapshotRoutesOptions {
  onSnapshotRequested?: (input: SnapshotRequestDto) => Promise<SnapshotReportDto>
}

export async function snapshotRoutes(app: FastifyInstance, opts: SnapshotRoutesOptions) {
  app.post<{
    Body: SnapshotRequestDto
  }>('/snapshot', async (request, reply) => {
    const parsed = snapshotRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      const err = validationError('Invalid snapshot payload', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
      return reply.status(err.statusCode).send(err.toJSON())
    }

    if (!opts.onSnapshotRequested) {
      const err = notImplemented('Snapshot reporting is not supported in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    try {
      const report = await opts.onSnapshotRequested(parsed.data)
      return reply.send(report)
    } catch (err) {
      request.log.error({ err }, 'Snapshot report generation failed')
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Failed to generate snapshot report',
        },
      })
    }
  })
}
