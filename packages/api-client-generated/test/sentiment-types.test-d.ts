import { expectTypeOf } from 'vitest'
import type { SentimentComparison, SentimentSummary, SentimentEvidencePage, GetApiV1ProjectsByNameSentimentEvidenceData } from '../src/index.js'

type Assessment = SentimentSummary['queries'][number]['assessments'][number]
expectTypeOf<Extract<Assessment['outcome'], null>>().toEqualTypeOf<null>()
expectTypeOf<Assessment['assessmentId']>().toEqualTypeOf<string | null>()
expectTypeOf<SentimentEvidencePage['selection']['assessmentId']>().toEqualTypeOf<string | undefined>()
expectTypeOf<NonNullable<GetApiV1ProjectsByNameSentimentEvidenceData['query']>['assessmentId']>().toEqualTypeOf<string | undefined>()

// The evidence outcome filter and its echo are optional outcome arrays.
type Outcome = NonNullable<Assessment['outcome']>
expectTypeOf<NonNullable<GetApiV1ProjectsByNameSentimentEvidenceData['query']>['outcome']>().toEqualTypeOf<Array<Outcome> | undefined>()
expectTypeOf<SentimentEvidencePage['selection']['outcome']>().toEqualTypeOf<Array<Outcome> | undefined>()

// The most criticized Properties are optional on every summary, comparison periods included.
expectTypeOf<SentimentSummary['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
expectTypeOf<SentimentComparison['from']['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
expectTypeOf<SentimentComparison['to']['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
