import type { AnswerServiceDefinition } from '../../core/types.js'
import { cloroDescriptor } from './descriptor.js'
import { cloroErrorMessage, parseCloroMonitorResponse } from './parse.js'
import { buildCloroMonitorRequest } from './request.js'

/** cloro monitor endpoints. Docs: docs/providers/answer-services/cloro.md. */
export const cloroMonitorService: AnswerServiceDefinition = {
  descriptor: cloroDescriptor,
  buildRequest: buildCloroMonitorRequest,
  parseResponse: parseCloroMonitorResponse,
  errorMessage: cloroErrorMessage,
}
