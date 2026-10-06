import { RELEASE_ID_REGEX } from './constants.js'

export function isValidReleaseId(id: string): boolean {
  return RELEASE_ID_REGEX.test(id)
}

export function formatReleaseId(year: number, window: string): string {
  return `cc-main-${year}-${window}`
}
