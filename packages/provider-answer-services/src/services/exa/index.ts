import type { AnswerServiceDefinition } from '../../core/types.js'
import { exaDescriptor } from './descriptor.js'
import { exaErrorMessage, parseExaAnswer } from './parse.js'
import { buildExaAnswerRequest } from './request.js'

/** Exa Answer. Docs: docs/providers/answer-services/exa.md. */
export const exaAnswerService: AnswerServiceDefinition = {
  descriptor: exaDescriptor,
  buildRequest: buildExaAnswerRequest,
  parseResponse: parseExaAnswer,
  errorMessage: exaErrorMessage,
}
