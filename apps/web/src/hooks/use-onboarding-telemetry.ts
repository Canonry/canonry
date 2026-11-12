import { useCallback, useRef } from 'react'
import type { OnboardingSurface as OnboardingTelemetrySurface, OnboardingTelemetryEvent } from '@canonry/canonry-contracts'

import { recordOnboardingEvent } from '../api.js'
import { createOnboardingEventId, getOrCreateOnboardingSessionId } from '../lib/onboarding-telemetry.js'

export type PendingOnboardingTelemetryEvent<T> = T extends unknown ? Omit<T, 'eventId' | 'surface'> : never

/**
 * Emit onboarding telemetry from one setup surface. Same event vocabulary and
 * session id as every other setup surface, tagged with the surface so their
 * funnels stay separable. A `dedupeKey` records an event once per mount.
 */
export function useOnboardingTelemetry(surface: OnboardingTelemetrySurface) {
  const onboardingSessionId = useRef(getOrCreateOnboardingSessionId()).current
  const recorded = useRef(new Set<string>())
  const emit = useCallback((
    event: PendingOnboardingTelemetryEvent<OnboardingTelemetryEvent>,
    dedupeKey?: string,
  ) => {
    if (dedupeKey) {
      if (recorded.current.has(dedupeKey)) return
      recorded.current.add(dedupeKey)
    }
    void recordOnboardingEvent({
      ...event,
      surface,
      eventId: createOnboardingEventId(),
    } as OnboardingTelemetryEvent)
  }, [surface])
  return { onboardingSessionId, emit }
}
