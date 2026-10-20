import { describe, expect, it } from 'vitest'
import { isQuestionUiCopy } from '../../../eslint-rules/canonry-vocabulary.js'

/**
 * Locks the classifier behind the `canonry-vocabulary/no-question-ui-copy`
 * lint rule (AGENTS.md "Vocabulary (Critical) → Query vs question"). Same
 * reasoning as `no-literal-palette.test.ts`: the predicate IS the gate, so if
 * it is wrong the gate is wrong — silently, in whichever direction hurts more.
 *
 * The hard part is not catching "Question type". It is separating UI copy from
 * the FROZEN wire names and the internal tokens that carry the same word, since
 * those cannot be renamed and must never cost a future author a
 * disable comment. Both directions are asserted.
 */
describe('isQuestionUiCopy', () => {
  it('flags UI copy that calls the tracked entity a question', () => {
    for (const text of [
      'Question type',
      'All questions',
      'Non-brand questions assigned to this Property',
      'Assign at least one question',
      'Tracked questions are loading.',
      'Could not clear this question assignment.',
      'Retry questions',
      'Add a question',
    ]) {
      expect(isQuestionUiCopy(text), text).toBe(true)
    }
  })

  it('flags a bare one-word label (the wizard step that read "Questions")', () => {
    expect(isQuestionUiCopy('Questions')).toBe(true)
    expect(isQuestionUiCopy('Question')).toBe(true)
    // JSX children arrive with their surrounding indentation.
    expect(isQuestionUiCopy('\n        Question\n      ')).toBe(true)
  })

  it('flags interpolated copy (template-literal quasis)', () => {
    expect(isQuestionUiCopy(' question assignments')).toBe(true)
    expect(isQuestionUiCopy(' still has assigned questions. Include it or remove those questions.')).toBe(true)
  })

  it('does NOT flag the FROZEN route paths and MCP tool names', () => {
    for (const text of [
      '/measurement-property-questions',
      '/measurement-question-result',
      '/api/v1/projects/{name}/measurement-property-questions',
      'canonry_measurement_property_questions',
      'canonry_measurement_question_result',
      'getApiV1ProjectsByNameMeasurementQuestionResultOptions',
    ]) {
      expect(isQuestionUiCopy(text), text).toBe(false)
    }
  })

  it('does NOT flag internal machine tokens (busy keys, DOM ids)', () => {
    for (const text of [
      'create-and-pair-questions',
      'property-questions',
      'no-question-assignments',
      'unclassified-query-assignments',
      'onCreateAndPairQuestions',
    ]) {
      expect(isQuestionUiCopy(text), text).toBe(false)
    }
  })

  it('does NOT flag copy that already uses the canonical word', () => {
    for (const text of [
      'Query type',
      'All queries',
      'Non-brand queries assigned to this Property',
      'Assign at least one query',
      ' query assignments',
      '',
      '   ',
    ]) {
      expect(isQuestionUiCopy(text), text).toBe(false)
    }
  })

  it('does NOT flag a non-string node value', () => {
    for (const value of [null, undefined, 42, true, /questions/]) {
      expect(isQuestionUiCopy(value)).toBe(false)
    }
  })
})
