import type { PlaceDetails } from './types.js'

/**
 * Reduce a Place Details resource to the human-readable amenities Google's
 * *rendered* listing asserts. This is the Places half of the GBP listing
 * cross-reference (#648): these are the amenities a guest sees on the public
 * listing, which we compare against the owner-configured GBP structured
 * profile to surface what the operator's profile doesn't expose.
 *
 * Pure + deterministic: amenities are emitted in a fixed declaration order and
 * de-duplicated (lunch/dinner/brunch collapse to one "on-site dining" token;
 * any parking / accessibility sub-option counts once). Tested exhaustively in
 * `test/amenities.test.ts` per the calculation-testing rule.
 */
export function extractPlaceAmenities(place: PlaceDetails): string[] {
  const out: string[] = []
  if (place.servesBreakfast) out.push('breakfast')
  if (place.servesLunch || place.servesDinner || place.servesBrunch) out.push('on-site dining')
  if (place.allowsDogs) out.push('pet-friendly')
  if (place.parkingOptions && Object.values(place.parkingOptions).some(Boolean)) out.push('parking')
  if (place.accessibilityOptions && Object.values(place.accessibilityOptions).some(Boolean)) out.push('wheelchair accessibility')
  if (place.restroom) out.push('restroom')
  if (place.goodForChildren) out.push('family-friendly')
  if (place.outdoorSeating) out.push('outdoor seating')
  if (place.reservable) out.push('reservations')
  return out
}
