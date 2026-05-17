/**
 * Subpath barrel for the TanStack Query helpers.
 *
 * Why a subpath: the `@ainyc/canonry-api-client` main barrel is consumed by
 * both the CLI (Node, no React) and the web SPA. The React Query plugin's
 * output imports `@tanstack/react-query` at the top of the file — importing
 * it transitively from the main barrel would force the CLI to install (or
 * tsup to bundle) a runtime dep it never uses.
 *
 * The web app imports from here:
 *   import { getApiV1ProjectsOptions } from '@ainyc/canonry-api-client/react-query'
 *
 * `@tanstack/react-query` is a peer dependency — the web app's own
 * installation provides the runtime; we just declare the version range.
 */
export * from './generated/@tanstack/react-query.gen.js'
