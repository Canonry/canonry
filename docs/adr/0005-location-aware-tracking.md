# ADR 0005: Location-Aware Keyword Tracking

## Decision

Add location as a first-class dimension to keyword tracking. Each keyword can be tracked from specific geographic locations (down to city level), and provider APIs receive location hints so search results reflect what users in that location would see.

## Why

- AI search APIs return different citations depending on user location — especially for local businesses, trending topics, and location-sensitive queries
- Canonry currently stores `country`/`language` per project but never passes them to provider APIs
- Users need to track whether they're cited for "best dentist" in Springfield, IL vs Springfield, MO — these return completely different results
- Community feedback confirmed the API-vs-live-search gap is real and gets worse with location-sensitive queries

## Data Model Decisions

- **Locations are per-keyword**: "best CRM" tracked from US+UK, "best dentist" from Springfield, IL only
- **Structured location objects**: `{ country, region?, city?, timezone? }` — maps directly to OpenAI/Claude `user_location` API params
- **Normalized locations table**: "Springfield, IL" is one record shared across keywords
- **Non-null sentinel `_default`** instead of nullable locationId — avoids SQLite NULL uniqueness issues
- **Snapshot immutability**: Full location context (label, country, region, city, timezone) snapshotted as JSON on `query_snapshots` at query time. Survives renames, deletes, and project country changes.
- **ON DELETE RESTRICT**: Cannot delete a location that has keywords referencing it (avoids SET NULL collapse)
- **Re-key on keywordId**: All grouping/dedup uses keywordId (already location-specific) not raw keyword text

### Verified SDK Support

| Provider | Param | Fields |
|----------|-------|--------|
| OpenAI `web_search_preview` | `user_location` | `{ type: 'approximate', country?, region?, city?, timezone? }` |
| Claude `web_search_20250305` | `user_location` | `{ type: 'approximate', country?, region?, city?, timezone? }` |
| Gemini `googleSearch` | None in SDK | Prompt-level hint |
| Local | N/A | Prompt-level hint |

---

## Phase 1: DB Schema + Contracts

### New `locations` table
File: `packages/db/src/schema.ts`

```typescript
export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),           // "_default" for project default, or auto-generated "Springfield, Illinois, US"
  country: text('country'),                 // ISO 3166-1 alpha-2
  region: text('region'),                   // Free text
  city: text('city'),                       // Free text
  timezone: text('timezone'),               // IANA timezone
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_locations_project').on(table.projectId),
  uniqueIndex('idx_locations_project_label').on(table.projectId, table.label),
])
```

### Add `locationId` to `keywords` table
- Column: `locationId: text('location_id').notNull().default('_default').references(() => locations.id, { onDelete: 'restrict' })`
- Replace unique index `(projectId, keyword)` → `(projectId, keyword, locationId)`
- Each project auto-creates a `_default` location row during project creation

### Add `locationContext` to `querySnapshots` table
- Column: `locationContext: text('location_context').notNull().default('{}')`
- JSON: `{ locationId, label, country, region, city, timezone }`
- No FK — denormalized, immutable historical record

### Migration
File: `packages/db/src/migrate.ts`

1. `CREATE TABLE IF NOT EXISTS locations (...)`
2. Insert `_default` location per existing project (inherits project country)
3. `ALTER TABLE keywords ADD COLUMN location_id TEXT NOT NULL DEFAULT '_default'`
4. Backfill: `UPDATE keywords SET location_id = (SELECT id FROM locations WHERE project_id = keywords.project_id AND label = '_default')`
5. Drop old index, create new `(project_id, keyword, location_id)` index
6. `ALTER TABLE query_snapshots ADD COLUMN location_context TEXT NOT NULL DEFAULT '{}'`

### Contract types
File: `packages/contracts/src/location.ts` (new)

- `LocationDto`: `{ id, label, country?, region?, city?, timezone? }`
- `CreateLocationInput`: `{ country?, region?, city?, timezone?, label? }`
- `SnapshotLocationContext`: `{ locationId, label, country?, region?, city?, timezone? }`

### Extend existing contracts
- `TrackedQueryInput` (`packages/contracts/src/provider.ts`): add `country?, region?, city?, timezone?`
- Snapshot DTO (`packages/contracts/src/run.ts`): add `locationContext?: SnapshotLocationContext`
- Config schema (`packages/contracts/src/config-schema.ts`): `spec.locations` array, keyword `{ keyword, locations }` objects

---

## Phase 2: Provider Wiring

### All four adapters
Files: `packages/provider-*/src/adapter.ts`

Each adapter's `executeTrackedQuery` (line ~49) manually reconstructs input — must forward new `country/region/city/timezone` fields. Also update internal `*TrackedQueryInput` types in each `normalize.ts`.

### OpenAI — native `user_location`
File: `packages/provider-openai/src/normalize.ts`

Pass `user_location: { type: 'approximate', country, region, city, timezone }` to `web_search_preview` tool config.

### Claude — native `user_location`
File: `packages/provider-claude/src/normalize.ts`

Same structure on `web_search_20250305` tool config (includes timezone).

### Gemini — prompt-level hint
File: `packages/provider-gemini/src/normalize.ts`

Modify `buildPrompt()` to append `(searching from Springfield, Illinois, US)` when location provided.

### Local — prompt-level hint
File: `packages/provider-local/src/normalize.ts`

Same prompt-level approach.

### Job runner
File: `packages/canonry/src/job-runner.ts`

- Pre-fetch all locations for project before keyword loop
- Pass `country/region/city/timezone` from location record to `TrackedQueryInput`
- Snapshot `locationContext` JSON at insert time (line 149)

---

## Phase 3: API Routes

### Location CRUD
File: `packages/api-routes/src/locations.ts` (new)

- `GET /projects/:name/locations` — list (includes `_default`)
- `POST /projects/:name/locations` — create. Auto-generate label from fields.
- `DELETE /projects/:name/locations/:id` — 409 if keywords reference it, cannot delete `_default`

### Route registration
File: `packages/api-routes/src/index.ts` — register `locationRoutes`

### Keyword endpoints
File: `packages/api-routes/src/keywords.ts`

- Accept `locationId` or `locationLabel` per keyword. Default to `_default`.
- GET: join with locations, return `location: LocationDto`
- Validate locationId belongs to same project

### Export endpoint
File: `packages/api-routes/src/projects.ts` (line 138)

Include `spec.locations` array and per-keyword location references. Plain string for `_default`, object for located keywords.

### Timeline
File: `packages/api-routes/src/history.ts`

Add `keywordId` and `locationLabel` to timeline response entries. Same keyword with different locations = separate timeline entries (already naturally separated by `keywordId`).

### Snapshot responses
File: `packages/api-routes/src/runs.ts`

Include parsed `locationContext` in snapshot responses.

---

## Phase 4: CLI

### Location commands
File: `packages/canonry/src/commands/location.ts` (new)

- `canonry location add <project> --country US --region Illinois --city Springfield`
- `canonry location list <project>`
- `canonry location remove <project> <label>`

### Keyword commands
File: `packages/canonry/src/commands/keyword.ts`

- `canonry keyword add <project> "best dentist" --location "Springfield, Illinois, US"`
- Without `--location`, uses `_default`

### Client + CLI registration
Files: `packages/canonry/src/client.ts`, `packages/canonry/src/cli.ts`

---

## Phase 5: Web UI

### API client types
File: `apps/web/src/api.ts`

- Extend `ApiKeyword`: add `locationId`, `location?: LocationDto`
- Extend `ApiSnapshot`: add `locationContext`
- Extend `ApiTimelineEntry`: add `keywordId`, `locationLabel`
- Add `fetchLocations()`

### View models
File: `apps/web/src/view-models.ts`

- `CitationInsightVm`: add `locationId`, `locationLabel`
- `ProjectCommandCenterVm`: add `locationScores[]`

### Dashboard builder — location filter + re-keying
File: `apps/web/src/build-dashboard.ts`

- `buildProjectCommandCenter()`: accept `locationFilter?` param, filter snapshots before aggregation
- `buildEvidenceFromTimeline()` (line 183): re-key `seenKeywords` set and snapshot grouping on `keywordId` not keyword text
- `buildInsights()` (line 326): group `phraseMap` on `keyword + '::' + locationId`
- Compute `locationScores` from snapshot `locationContext`

### UI components
File: `apps/web/src/App.tsx`

- **LocationBadge**: pill badge, slate tone, shows label (hidden for `_default`)
- **Evidence cards**: show LocationBadge next to keyword text
- **Location breakdown card**: parallel to provider breakdown, shows per-location citation rates
- **Location filter chips**: `All` + location labels, clicking re-computes entire VM for that location

---

## Phase 6: Tests

### Export roundtrip
File: `packages/api-routes/test/export-roundtrip.test.ts`

- Create project with locations + located keywords
- Export → verify `spec.locations` and keyword location refs
- Re-apply → verify round-trip preserves

### Provider tests
Verify each adapter forwards location fields to API call / prompt.

---

## Consequences

- Keyword count multiplies with locations: 20 keywords × 3 locations × 3 providers = 180 snapshots per run. Quota checks must account for this.
- The `_default` sentinel location row per project adds a small overhead but avoids NULL uniqueness edge cases in SQLite.
- `ON DELETE RESTRICT` on location FK means users must reassign keywords before deleting a location.
- Gemini location support is prompt-level only (no SDK param) — results are less reliably geo-targeted than OpenAI/Claude.
- Historical snapshots are immutable — renaming a location doesn't retroactively change old run data. This is intentional for audit integrity.

## Complete File List

| File | Phase | Changes |
|------|-------|---------|
| `packages/db/src/schema.ts` | 1 | `locations` table, `locationId` on keywords, `locationContext` on snapshots |
| `packages/db/src/migrate.ts` | 1 | Migration: create table, backfill, swap index |
| `packages/contracts/src/location.ts` | 1 | **New** — LocationDto, CreateLocationInput, SnapshotLocationContext |
| `packages/contracts/src/index.ts` | 1 | Export location types |
| `packages/contracts/src/provider.ts` | 1 | Extend TrackedQueryInput |
| `packages/contracts/src/run.ts` | 1 | Extend snapshot DTO |
| `packages/contracts/src/config-schema.ts` | 1 | locations in spec, keyword location references |
| `packages/provider-openai/src/adapter.ts` | 2 | Forward location fields |
| `packages/provider-openai/src/normalize.ts` | 2 | Pass user_location to web_search_preview |
| `packages/provider-claude/src/adapter.ts` | 2 | Forward location fields |
| `packages/provider-claude/src/normalize.ts` | 2 | Pass user_location to web_search_20250305 |
| `packages/provider-gemini/src/adapter.ts` | 2 | Forward location fields |
| `packages/provider-gemini/src/normalize.ts` | 2 | Location hint in buildPrompt() |
| `packages/provider-local/src/adapter.ts` | 2 | Forward location fields |
| `packages/provider-local/src/normalize.ts` | 2 | Location hint in buildPrompt() |
| `packages/canonry/src/job-runner.ts` | 2 | Fetch locations, pass to providers, snapshot locationContext |
| `packages/api-routes/src/index.ts` | 3 | Register locationRoutes |
| `packages/api-routes/src/locations.ts` | 3 | **New** — location CRUD |
| `packages/api-routes/src/keywords.ts` | 3 | Handle locationId in keyword CRUD |
| `packages/api-routes/src/projects.ts` | 3 | Locations in export |
| `packages/api-routes/src/runs.ts` | 3 | locationContext in snapshot response |
| `packages/api-routes/src/history.ts` | 3 | keywordId + locationLabel in timeline |
| `packages/canonry/src/client.ts` | 4 | Location client methods |
| `packages/canonry/src/cli.ts` | 4 | Register location command |
| `packages/canonry/src/commands/location.ts` | 4 | **New** — location CLI |
| `packages/canonry/src/commands/keyword.ts` | 4 | --location flag |
| `apps/web/src/api.ts` | 5 | Extend types, fetchLocations |
| `apps/web/src/view-models.ts` | 5 | locationId/label, locationScores |
| `apps/web/src/build-dashboard.ts` | 5 | Filter param, re-key on keywordId, locationScores |
| `apps/web/src/App.tsx` | 5 | LocationBadge, breakdown card, filter chips |
| `packages/api-routes/test/export-roundtrip.test.ts` | 6 | Location round-trip test |
