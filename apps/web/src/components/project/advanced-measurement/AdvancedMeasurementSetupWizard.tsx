import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

export type AdvancedMeasurementSetupStep = 'import' | 'properties' | 'groups' | 'queries' | 'review'

const setupSteps: readonly { id: AdvancedMeasurementSetupStep; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'properties', label: 'Properties' },
  { id: 'groups', label: 'Groups' },
  { id: 'queries', label: 'Queries' },
  { id: 'review', label: 'Review and publish' },
]

export interface AdvancedMeasurementSetupWizardProps {
  currentStep: AdvancedMeasurementSetupStep
  hasDraft: boolean
  canEdit: boolean
  onDiscard?: () => void
  onStepChange?: (step: AdvancedMeasurementSetupStep) => void
  children: ReactNode
}

export function AdvancedMeasurementSetupWizard({
  currentStep,
  hasDraft,
  canEdit,
  onDiscard,
  onStepChange,
  children,
}: AdvancedMeasurementSetupWizardProps) {
  const previousStepRef = useRef<AdvancedMeasurementSetupStep | null>(null)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  const discardTriggerRef = useRef<HTMLButtonElement>(null)
  const wasDiscardArmedRef = useRef(false)
  const [discardArmed, setDiscardArmed] = useState(false)

  useEffect(() => {
    if (!hasDraft) setDiscardArmed(false)
  }, [hasDraft])

  useEffect(() => {
    const wasArmed = wasDiscardArmedRef.current
    wasDiscardArmedRef.current = discardArmed
    if (discardArmed) keepEditingRef.current?.focus()
    else if (wasArmed) discardTriggerRef.current?.focus()
  }, [discardArmed])

  useEffect(() => {
    const previousStep = previousStepRef.current
    previousStepRef.current = currentStep

    if (previousStep === null || previousStep === currentStep) return

    const heading = stepContentRef.current?.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]')
    if (!heading) return

    heading.tabIndex = -1
    heading.focus()
  }, [currentStep])

  return (
    <div className="space-y-6">
      <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <div className="min-w-0 w-full sm:flex-1">
          <h2>Advanced measurement setup</h2>
          <p className="mt-1 max-w-2xl text-copy-14 text-secondary">
            Choose the Properties and queries you want to measure.
          </p>
        </div>
        {hasDraft ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-end">
            <ToneBadge tone="caution">Unpublished changes</ToneBadge>
            {canEdit && onDiscard ? discardArmed ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm discard">
                <span className="text-label-14 text-secondary">Discard all unpublished changes?</span>
                <Button ref={keepEditingRef} type="button" size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setDiscardArmed(false)}>
                  Keep editing
                </Button>
                <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={onDiscard}>
                  Discard unpublished changes
                </Button>
              </div>
            ) : (
              <Button ref={discardTriggerRef} type="button" size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setDiscardArmed(true)}>
                Discard changes
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div role="group" aria-label="Advanced measurement setup progress" className="overflow-x-auto border-b border-default">
        <ol className="flex min-w-max gap-6">
          {setupSteps.map(step => (
            <li key={step.id}>
              {onStepChange ? (
                <button
                  type="button"
                  aria-current={currentStep === step.id ? 'step' : undefined}
                  onClick={() => onStepChange(step.id)}
                  className={`block min-h-11 border-b-2 bg-transparent px-1 py-3 text-left text-button-14 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${
                    currentStep === step.id
                      ? 'border-strong text-heading'
                      : 'border-transparent text-secondary hover:text-heading'
                  }`}
                >
                  {step.label}
                </button>
              ) : (
                <span
                  aria-current={currentStep === step.id ? 'step' : undefined}
                  className={`block min-h-11 border-b-2 px-1 py-3 text-label-14-strong ${
                    currentStep === step.id
                      ? 'border-strong text-heading'
                      : 'border-transparent text-secondary'
                  }`}
                >
                  {step.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div ref={stepContentRef}>{children}</div>
    </div>
  )
}
