import type { AnswerServiceDefinition } from '../../core/types.js'
import { parallelDescriptor } from './descriptor.js'
import { parallelErrorMessage, parseParallelResponse } from './parse.js'
import { buildParallelResponsesRequest } from './request.js'

/** Parallel Responses. Docs: docs/providers/answer-services/parallel.md. */
export const parallelResponsesService: AnswerServiceDefinition = {
  descriptor: parallelDescriptor,
  buildRequest: buildParallelResponsesRequest,
  parseResponse: parseParallelResponse,
  errorMessage: parallelErrorMessage,
}
