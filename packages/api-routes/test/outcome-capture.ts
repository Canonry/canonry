import Fastify from 'fastify'
import { AppError, integrationConnectionPropertiesSchema, type IntegrationConnectionProperties } from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { createOutcomeEmitter, type OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'
import { registerRequestContext } from '../src/request-context.js'

/** A bare app with request context and an outcome sink, for one route plugin under test. */
export function outcomeApp(db: DatabaseClient) {
  const outcomes: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  registerRequestContext(app)
  app.decorate('db', db)
  app.decorate('emitOutcome', createOutcomeEmitter((event) => { outcomes.push(event) }))
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    throw error
  })
  return { app, outcomes }
}

/** The `integration.connection` properties reported, each parsed by the schema the host enforces. */
export function connectionOutcomes(outcomes: readonly OutcomeTelemetryEvent[]): IntegrationConnectionProperties[] {
  return outcomes.flatMap(event => event.event === 'integration.connection'
    ? [integrationConnectionPropertiesSchema.parse(event.properties)]
    : [])
}
