import { createAnswerServiceAdapter } from './core/adapter.js'
import { ANSWER_SERVICES } from './services/index.js'

export { createAnswerServiceAdapter, AnswerServiceQueryTooLongError, type AnswerServiceAdapterOptions } from './core/adapter.js'
export {
  AnswerServiceHttpError,
  AnswerServiceStreamError,
  isRetryableAnswerRequest,
  MAX_RESPONSE_BYTES,
} from './core/http.js'
export { MAX_STORED_RAW_BYTES } from './core/evidence.js'
export {
  AnswerServiceJobSubmitError,
  type AnswerServiceDefinition,
  type AnswerServiceHttpRequest,
  type AnswerServiceJobHandlers,
  type AnswerServiceParseContext,
  type AnswerServiceRequestInput,
  type AnswerServiceStreamEnd,
  type ParsedAnswer,
} from './core/types.js'
export { ANSWER_SERVICES } from './services/index.js'

/** One provider adapter per registered service, spread once into the server's adapter list. */
export const answerServiceAdapters = ANSWER_SERVICES.map(service => createAnswerServiceAdapter(service))

/** Descriptors of every registered service, for hosts that only need metadata (settings, env bootstrap). */
export const answerServiceDescriptors = ANSWER_SERVICES.map(service => service.descriptor)
