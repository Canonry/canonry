import type { GoogleSignInConfig } from '@ainyc/canonry-contracts'
import type { GoogleOidcClient } from './google-sign-in-client.js'

export interface GoogleSignInOptions {
  getConfig: () => GoogleSignInConfig
  updateConfig?: (value: GoogleSignInConfig) => void | Promise<void>
  publicUrl?: string
  basePath?: string
  environmentOverride?: boolean
  /** Internal transport seam for offline protocol tests; not instance configuration. */
  clientFactory?: (credentials: { clientId: string; clientSecret: string }) => GoogleOidcClient
}
