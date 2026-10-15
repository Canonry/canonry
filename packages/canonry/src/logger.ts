/** Compatibility surface; runtime logging is shared with Fastify in api-routes. */
export {
  addLogListener,
  createFastifyLogger,
  createLogger,
  type CreateFastifyLoggerOptions,
  type Logger,
  type LogEntry,
  type LogLevel,
} from '@canonry/canonry-api-routes/runtime-logger'
