import { z } from 'zod'

// One GBP location surfaced to canonry — a row in `gbp_locations`. The
// `accountName` / `locationName` fields are the resource names returned by
// Google ("accounts/{n}" / "locations/{n}"); we keep the full form rather
// than stripping the numeric ID because both v1 and v4 endpoints expect
// the full path.
export const gbpLocationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountName: z.string(),
  locationName: z.string(),
  displayName: z.string(),
  primaryCategoryDisplayName: z.string().nullable(),
  storefrontAddress: z.string().nullable(),
  websiteUri: z.string().nullable(),
  selected: z.boolean(),
  syncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GbpLocationDto = z.infer<typeof gbpLocationDtoSchema>

export const gbpLocationListResponseSchema = z.object({
  locations: z.array(gbpLocationDtoSchema),
  totalDiscovered: z.number().int().nonnegative(),
  totalSelected: z.number().int().nonnegative(),
})
export type GbpLocationListResponse = z.infer<typeof gbpLocationListResponseSchema>

export const gbpDiscoverRequestSchema = z.object({
  selectAllNew: z.boolean().default(true),
})
export type GbpDiscoverRequest = z.infer<typeof gbpDiscoverRequestSchema>

export const gbpLocationSelectionRequestSchema = z.object({
  selected: z.boolean(),
})
export type GbpLocationSelectionRequest = z.infer<typeof gbpLocationSelectionRequestSchema>
