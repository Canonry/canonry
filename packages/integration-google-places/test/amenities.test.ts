import { describe, it, expect } from 'vitest'
import { extractPlaceAmenities } from '../src/amenities.js'

describe('extractPlaceAmenities', () => {
  it('returns [] for an empty place', () => {
    expect(extractPlaceAmenities({})).toEqual([])
  })

  it('maps each true amenity boolean to a human label', () => {
    expect(extractPlaceAmenities({ servesBreakfast: true })).toEqual(['breakfast'])
    expect(extractPlaceAmenities({ allowsDogs: true })).toEqual(['pet-friendly'])
    expect(extractPlaceAmenities({ restroom: true })).toEqual(['restroom'])
    expect(extractPlaceAmenities({ goodForChildren: true })).toEqual(['family-friendly'])
    expect(extractPlaceAmenities({ outdoorSeating: true })).toEqual(['outdoor seating'])
    expect(extractPlaceAmenities({ reservable: true })).toEqual(['reservations'])
  })

  it('ignores false / missing amenities', () => {
    expect(extractPlaceAmenities({ servesBreakfast: false, allowsDogs: false })).toEqual([])
  })

  it('collapses lunch/dinner/brunch into a single on-site dining token', () => {
    expect(extractPlaceAmenities({ servesDinner: true })).toEqual(['on-site dining'])
    expect(extractPlaceAmenities({ servesLunch: true, servesDinner: true, servesBrunch: true })).toEqual(['on-site dining'])
  })

  it('counts parking only when at least one parking sub-option is true', () => {
    expect(extractPlaceAmenities({ parkingOptions: { freeParkingLot: true } })).toEqual(['parking'])
    expect(extractPlaceAmenities({ parkingOptions: { freeParkingLot: false, valetParking: false } })).toEqual([])
    expect(extractPlaceAmenities({ parkingOptions: {} })).toEqual([])
  })

  it('counts wheelchair accessibility only when an accessibility sub-option is true', () => {
    expect(extractPlaceAmenities({ accessibilityOptions: { wheelchairAccessibleEntrance: true } })).toEqual(['wheelchair accessibility'])
    expect(extractPlaceAmenities({ accessibilityOptions: { wheelchairAccessibleEntrance: false } })).toEqual([])
  })

  it('returns amenities in a stable order and de-duplicated', () => {
    const out = extractPlaceAmenities({
      reservable: true,
      servesBreakfast: true,
      allowsDogs: true,
      servesDinner: true,
      parkingOptions: { paidGarageParking: true },
    })
    // Stable declaration order: breakfast, dining, pets, parking, ..., reservations
    expect(out).toEqual(['breakfast', 'on-site dining', 'pet-friendly', 'parking', 'reservations'])
    expect(new Set(out).size).toBe(out.length)
  })
})
