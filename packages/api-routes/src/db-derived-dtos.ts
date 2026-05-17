/**
 * DTO schemas derived from the Drizzle table definitions via `drizzle-zod`.
 *
 * The hand-rolled DTO schemas in `@ainyc/canonry-contracts` remain the
 * canonical public surface — they're what generates the OpenAPI spec and
 * the `@ainyc/canonry-api-client` SDK. The schemas below are an internal
 * runtime-validator pair: for each migrated table, `createSelectSchema()`
 * walks the Drizzle column types and produces a Zod schema, with per-column
 * refinements applied where the SQL column type alone isn't expressive
 * enough (enum narrowing on text columns, inner-shape typing on JSON
 * columns whose `$type<>` is a TypeScript-only hint).
 *
 * Why a parallel "row schema" instead of just using the contracts DTO?
 *
 * 1. **Drift detection at the seam.** Routes that read from these tables
 *    can `.parse(row)` through the derived schema before handing the
 *    result to the consumer-facing DTO. If a future schema change drops
 *    a refinement (e.g. forgetting to narrow `configSource` to its enum
 *    after adding a new value), the parse fails loudly in tests rather
 *    than silently mis-typing the SDK output.
 *
 * 2. **Field-name coverage.** `db-derived-dtos.test.ts` asserts that
 *    `Object.keys(derivedSchema.shape) === Object.keys(getTableColumns(table))`
 *    — a stronger version of `db-dto-coverage.test.ts` (which only checks
 *    that DB columns appear in the hand-rolled DTO, not that the derived
 *    schema is exhaustive).
 *
 * 3. **Foundation for replacing `formatX` bridges.** Once the derived
 *    schema for a table is structurally equivalent to its public DTO
 *    (minus internal-only columns), `formatX(row)` collapses to
 *    `derivedSchema.parse(row)` plus an `omit({internal: true})` step.
 *    PRs after this one will land that replacement table by table.
 *
 * Why this lives in `api-routes` and not `contracts`:
 *
 * The `contracts` package can't import from `db` because `db` already
 * imports types (`LocationContext`, `ProviderName`, `DiscoveryCompetitorMapEntry`)
 * from `contracts` for the `$type<>()` hints on JSON columns. `api-routes`
 * sits above both and can import from either freely, so the derived
 * schemas live here. The day we want contracts to consume these (and
 * delete the hand-rolled DTOs entirely), we'd need to move the shared
 * types to a third package or invert the db ↔ contracts dependency.
 */

import { createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'
import {
  notifications,
  projects,
  runs,
  schedules,
} from '@ainyc/canonry-db'
import {
  configSourceSchema,
  locationContextSchema,
  notificationEventSchema,
  providerNameSchema,
  runKindSchema,
  runStatusSchema,
  runTriggerSchema,
  schedulableRunKindSchema,
} from '@ainyc/canonry-contracts'

// --- projects ---
// `createSelectSchema` infers `text({mode:'json'}).$type<T>()` columns as
// `ZodUnion` (drizzle-zod 0.8.x can't introspect TypeScript-only `$type`
// hints; it falls back to a loose union). The refinements below replace
// each JSON column with the narrowed Zod schema that matches the DB write
// shape, so the derived row schema is fully typed.
export const projectRowSchema = createSelectSchema(projects, {
  ownedDomains: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  providers: z.array(z.string()),
  locations: z.array(locationContextSchema),
  // text column → narrow to the configSource enum
  configSource: configSourceSchema,
})

// --- runs ---
export const runRowSchema = createSelectSchema(runs, {
  kind: runKindSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema,
  // nullable JSON column. createSelectSchema preserves the null on the
  // outer wrapper; the inner array shape needs the refinement.
  queries: z.array(z.string()).nullable(),
})

// --- schedules ---
export const scheduleRowSchema = createSelectSchema(schedules, {
  kind: schedulableRunKindSchema,
  providers: z.array(providerNameSchema),
})

// --- notifications ---
// `config` is a JSON column with `{url, events}` shape; refine to the
// narrowed structure the API surfaces via `formatNotification`.
export const notificationRowSchema = createSelectSchema(notifications, {
  channel: z.literal('webhook'),
  config: z.object({
    url: z.string().url(),
    events: z.array(notificationEventSchema),
  }),
})

// Inferred row types — re-exported for routes that want a fully-typed
// `Project` / `Run` / `Schedule` / `Notification` row without manual cast
// gymnastics. The hand-rolled DTOs in contracts remain the SDK source.
export type ProjectRow = z.infer<typeof projectRowSchema>
export type RunRow = z.infer<typeof runRowSchema>
export type ScheduleRow = z.infer<typeof scheduleRowSchema>
export type NotificationRow = z.infer<typeof notificationRowSchema>
