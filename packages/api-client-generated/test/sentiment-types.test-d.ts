import { expectTypeOf } from 'vitest'
import type { SentimentSummary, SentimentEvidencePage, GetApiV1ProjectsByNameSentimentEvidenceData } from '../src/index.js'

type Assessment = SentimentSummary['queries'][number]['assessments'][number]
expectTypeOf<Extract<Assessment['outcome'], null>>().toEqualTypeOf<null>()
expectTypeOf<Assessment['assessmentId']>().toEqualTypeOf<string | null>()
expectTypeOf<SentimentEvidencePage['selection']['assessmentId']>().toEqualTypeOf<string | undefined>()
expectTypeOf<NonNullable<GetApiV1ProjectsByNameSentimentEvidenceData['query']>['assessmentId']>().toEqualTypeOf<string | undefined>()
