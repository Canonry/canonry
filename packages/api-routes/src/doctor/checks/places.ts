import { eq } from 'drizzle-orm'
import { gbpLocations } from '@ainyc/canonry-db'
import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

/**
 * `gbp.places.api-key` — is the project ready to enrich its GBP lodging
 * locations with Places (New) rendered-listing data (#648)? Validates the
 * end-to-end prerequisites without spending a paid API call: tier enabled,
 * GBP connected, key present, and at least one tracked location carrying a
 * Maps place id (the join key). Live key validation is a future add.
 */
const apiKeyCheck: CheckDefinition = {
  id: 'gbp.places.api-key',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'Google Places API key',
  run: (ctx: DoctorContext): CheckOutput => {
    if (!ctx.project) {
      return { status: CheckStatuses.skipped, code: 'gbp.places.no-project', summary: 'Project context required.', remediation: null }
    }

    const cfg = ctx.getPlacesConfig?.()
    if (!cfg) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.places.config-unavailable',
        summary: 'Places config is not available in this deployment.',
        remediation: null,
      }
    }

    if (cfg.tier === 'off') {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.places.disabled',
        summary: 'Places enrichment is disabled (tier: off).',
        remediation: 'Set `google.places.tier` to `atmosphere` or `pro` in ~/.canonry/config.yaml to enable it.',
      }
    }

    // Places only matters once GBP is connected for the project.
    const conn = ctx.googleConnectionStore?.getConnection(ctx.project.canonicalDomain, 'gbp')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.places.no-gbp-connection',
        summary: 'No Google Business Profile connection; Places enrichment does not apply.',
        remediation: `Connect GBP first: \`canonry gbp connect ${ctx.project.name}\`.`,
      }
    }

    if (!cfg.apiKey) {
      return {
        status: CheckStatuses.warn,
        code: 'gbp.places.api-key-missing',
        summary: 'No Places API key configured — GBP-vs-rendered-listing discrepancies cannot be detected.',
        remediation: 'Set `GOOGLE_PLACES_API_KEY` or `google.places.apiKey` in ~/.canonry/config.yaml. The amenity cross-reference fits the 1,000 free Atmosphere calls/month for a typical operator book.',
        details: { tier: cfg.tier },
      }
    }

    const rows = ctx.db
      .select({ placeId: gbpLocations.placeId, selected: gbpLocations.selected })
      .from(gbpLocations)
      .where(eq(gbpLocations.projectId, ctx.project.id))
      .all()
    const selected = rows.filter((r) => r.selected)
    const locationsWithPlaceId = selected.filter((r) => Boolean(r.placeId)).length
    const details = {
      tier: cfg.tier,
      refreshIntervalDays: cfg.refreshIntervalDays,
      selectedLocations: selected.length,
      locationsWithPlaceId,
    }

    // Selected locations exist but none carry a place id → the key can't be
    // used until discovery captures place ids.
    if (selected.length > 0 && locationsWithPlaceId === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'gbp.places.no-place-ids',
        summary: `None of the ${selected.length} selected location(s) have a Maps place id, so Places enrichment can't run.`,
        remediation: `Run \`canonry gbp locations discover ${ctx.project.name}\` to capture place ids from location metadata.`,
        details,
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'gbp.places.ready',
      summary: `Places enrichment ready (tier: ${cfg.tier}). ${locationsWithPlaceId}/${selected.length} selected location(s) have a Maps place id.`,
      remediation: null,
      details,
    }
  },
}

export const PLACES_CHECKS: readonly CheckDefinition[] = [apiKeyCheck]

export const PLACES_CHECK_BY_ID = Object.fromEntries(
  PLACES_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
