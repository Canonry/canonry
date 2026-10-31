import type { AnswerServiceDefinition } from '../core/types.js'
import { exaAnswerService } from './exa/index.js'
import { parallelResponsesService } from './parallel/index.js'

/**
 * The single registration list. A vendor adds its folder under
 * `src/services/<vendor>/` (descriptor, request builder, parser) and one
 * entry here; nothing else in the repository changes.
 */
export const ANSWER_SERVICES: readonly AnswerServiceDefinition[] = [
  exaAnswerService,
  parallelResponsesService,
]
