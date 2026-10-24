import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { getApiV1ProjectsByNameMeasurementQuestionResultOptions } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { Button } from '../ui/button.js'
import { AnswerMarkdown } from './AnswerMarkdown.js'
import { StatusNote } from './StatusNote.js'

/** Answers are read from the last sweep, as the pages that list them are. */
const LAST_SWEEP = { fallback: 'last-sweep' } as const

/**
 * The answer itself, fetched when a row is opened.
 *
 * The row above it can only ever say whether this Property was named. It cannot
 * say what the engine actually recommended, and that is the thing an operator
 * opens the row to find out: a "not mentioned" row on a local-market query can
 * turn out to be an answer recommending two other properties from the brand.
 * None of that is visible in a signal badge or a source count.
 *
 * Fetched per row rather than with the list because an answer runs to several
 * thousand characters and most rows are never opened. `observationId` is the
 * `resultId` this read takes — both are the stored snapshot id — so no new
 * plumbing is needed to line them up.
 */
/** `headingLevel` is the level of the answer's own top headings: one below the heading the answer is read under. */
export function AnswerText({ project, targetKey, resultId, headingLevel }: { project: string; targetKey: string; resultId: string; headingLevel: 4 | 5 }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementQuestionResultOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, resultId, ...LAST_SWEEP },
    }),
  })

  if (query.isPending) {
    return (
      <p className="py-2 text-sm text-secondary" role="status" aria-live="polite">Loading the answer&hellip;</p>
    )
  }
  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-2">
        <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Load failed" detail="This answer did not load." /></span>
        <Button type="button" size="sm" variant="outline" className="h-11 px-4 text-sm md:h-11" aria-label="Retry answer" onClick={() => { void query.refetch() }}>Retry</Button>
      </div>
    )
  }
  const answer = query.data?.answer
  if (answer === null || answer === undefined || answer.trim() === '') {
    // A measured answer with no stored text is not the same as an empty answer,
    // and neither is worth dressing up as one.
    return <div className="py-2"><StatusNote icon={AlertTriangle} tone="caution" label="Text not saved" detail="This answer was measured, but its text was not stored." /></div>
  }
  return (
    <div className="py-2">
      <AnswerMarkdown headingLevel={headingLevel} copyable>{answer}</AnswerMarkdown>
    </div>
  )
}

