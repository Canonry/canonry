import { test, expect } from 'vitest'
import { orderLocationsDefaultFirst } from '../src/index.js'


// ---------------------------------------------------------------------------
// orderLocationsDefaultFirst — discovery probes must follow the same geo
// default as sweeps (project.defaultLocation), not config order.
// ---------------------------------------------------------------------------

test('orderLocationsDefaultFirst moves the default location to the front, order otherwise stable', () => {
  const phoenix = { label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }
  const tucson = { label: 'tucson', city: 'Tucson', region: 'Arizona', country: 'US' }
  const mesa = { label: 'mesa', city: 'Mesa', region: 'Arizona', country: 'US' }
  expect(orderLocationsDefaultFirst([phoenix, tucson, mesa], 'tucson')).toEqual([tucson, phoenix, mesa])
})

test('orderLocationsDefaultFirst is a no-op when the default is absent, unknown, or already first', () => {
  const phoenix = { label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }
  const tucson = { label: 'tucson', city: 'Tucson', region: 'Arizona', country: 'US' }
  expect(orderLocationsDefaultFirst([phoenix, tucson], null)).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([phoenix, tucson], 'nowhere')).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([phoenix, tucson], 'phoenix')).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([], 'phoenix')).toEqual([])
})
