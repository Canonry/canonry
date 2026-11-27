import { formatModelName, openRouterRouteModel } from '@canonry/canonry-contracts'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'

export function AnswerEngineLabel({ provider }: { provider: string }) {
  const model = openRouterRouteModel(provider)
  return <>
    <span className="block text-label-14-strong text-primary">{model ? formatModelName(model) : providerDisplayName(provider)}</span>
    {model && <> <span className="block text-label-13 text-secondary">via OpenRouter</span></>}
  </>
}
