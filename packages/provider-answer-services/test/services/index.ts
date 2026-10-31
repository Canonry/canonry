import type { ConformanceFixtures } from '../conformance.js'
import { EXA_CONFORMANCE_FIXTURES } from './exa/fixtures.js'
import { PARALLEL_CONFORMANCE_FIXTURES } from './parallel/fixtures.js'

/**
 * Documentation-derived conformance fixtures, one entry per registered
 * service (`src/services/index.ts`). A vendor adds its fixtures file under
 * `test/services/<vendor>/` and one entry here; the shared matrix in
 * `conformance.test.ts` does the rest.
 */
export const SERVICE_CONFORMANCE_FIXTURES: readonly ConformanceFixtures[] = [
  EXA_CONFORMANCE_FIXTURES,
  PARALLEL_CONFORMANCE_FIXTURES,
]
