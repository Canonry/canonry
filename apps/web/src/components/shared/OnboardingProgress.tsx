export type OnboardingStage = 'site' | 'fixes' | 'visibility'

/**
 * The path from setup to a result used five names for one crawl: "Site audit"
 * here, "Map your site" as the heading, "Map site" on the button, "Site Health"
 * on the tab it lands on, and "Page health" for its score. Two are enough: the
 * scan, and the score it produces. "Site Health" is the product name the tab
 * and the CLI already use, so the scan takes it.
 */
const ONBOARDING_STAGES = [
  { id: 'site', label: 'Scan site', optional: false },
  { id: 'fixes', label: 'Page health', optional: false },
  { id: 'visibility', label: 'AI Visibility', optional: true },
] as const satisfies ReadonlyArray<{
  id: OnboardingStage
  label: string
  optional?: boolean
}>

export function OnboardingProgress({ current }: { current: OnboardingStage }) {
  const currentIndex = ONBOARDING_STAGES.findIndex((stage) => stage.id === current)

  return (
    <ol
      aria-label="Onboarding progress"
      className="grid border-y border-default sm:grid-cols-3 sm:divide-x sm:divide-default"
    >
      {ONBOARDING_STAGES.map((stage, index) => {
        const complete = index < currentIndex
        const active = index === currentIndex

        return (
          <li
            key={stage.id}
            aria-current={active ? 'step' : undefined}
            className="flex min-h-12 items-center gap-3 py-2 sm:px-3 sm:first:pl-0 sm:last:pr-0"
          >
            <span
              aria-hidden="true"
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${
                active
                  ? 'border-accent bg-accent text-on-inverse'
                  : complete
                    ? 'border-positive bg-positive-soft text-positive'
                    : 'border-default bg-surface-subtle text-muted'
              }`}
            >
              {complete ? '✓' : index + 1}
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className={`text-sm font-medium ${active || complete ? 'text-heading' : 'text-secondary'}`}>
                {stage.label}
              </span>
              {stage.optional ? <span className="text-[13px] text-secondary">Optional</span> : null}
              {complete ? <span className="sr-only">Complete</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
