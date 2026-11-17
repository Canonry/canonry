import type { AnswerServiceDefinition } from '../../core/types.js'
import { goanyapiDescriptor } from './descriptor.js'
import { goanyapiErrorMessage, parseGoanyapiAiOverview } from './parse.js'
import { buildGoanyapiAiOverviewRequest } from './request.js'

/** GoAnyAPI Google AI Overview. Docs: docs/providers/answer-services/goanyapi.md. */
export const goanyapiAnswerService: AnswerServiceDefinition = {
  descriptor: goanyapiDescriptor,
  buildRequest: buildGoanyapiAiOverviewRequest,
  parseResponse: parseGoanyapiAiOverview,
  errorMessage: goanyapiErrorMessage,
}
