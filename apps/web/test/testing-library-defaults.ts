import { configure } from '@testing-library/react'

/**
 * `findBy*` / `waitFor` default to giving up after 1s. Under the root
 * aggregate run (`pnpm test` / `pnpm verify`, 1,000+ files across every
 * package in one process) a render can legitimately take longer than that,
 * which surfaced as "Unable to find role=..." failures that pass on their
 * own. A longer ceiling only costs time when a query is already failing.
 */
configure({ asyncUtilTimeout: 5_000 })
