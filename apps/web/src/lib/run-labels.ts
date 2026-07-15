import { RunKinds, type RunKind } from '@ainyc/canonry-contracts'

export function formatTrackedRunKind(kind: RunKind): string {
  switch (kind) {
    case RunKinds['answer-visibility']: return 'Visibility sweep'
    case RunKinds['gsc-sync']: return 'GSC sync'
    case RunKinds['inspect-sitemap']: return 'Sitemap inspection'
    case RunKinds['ga-sync']: return 'GA sync'
    case RunKinds['traffic-sync']: return 'Traffic sync'
    case RunKinds['bing-inspect']: return 'Bing URL inspection'
    case RunKinds['bing-inspect-sitemap']: return 'Bing sitemap inspection'
    case RunKinds['site-audit']: return 'Technical audit'
    case RunKinds['backlink-extract']: return 'Backlink extract'
    case RunKinds['aeo-discover-seed']: return 'Discovery (seed phase)'
    case RunKinds['aeo-discover-probe']: return 'Discovery (probe phase)'
    case RunKinds['gbp-sync']: return 'Business Profile sync'
    case RunKinds['ads-sync']: return 'ChatGPT ads sync'
  }
}
