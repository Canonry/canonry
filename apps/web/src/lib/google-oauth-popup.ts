import { googleConnect } from '../api.js'

/** The message the OAuth callback page posts to its opener (`googleOAuthSuccessHtml`). */
export const GOOGLE_OAUTH_COMPLETE_MESSAGE = 'canonry:google-oauth-complete'

export type GoogleOAuthConnectionType = 'gsc' | 'gbp'

export const UNEXPECTED_OAUTH_URL_MESSAGE = 'Unexpected OAuth redirect URL. Please try again.'

/**
 * Starts the shared Google OAuth flow for one connection type in a popup.
 *
 * Resolves once the popup is open (`'popup'`) or the page is navigating to
 * Google because the browser blocked it (`'redirect'`). `onFinished` runs once:
 * `true` when the callback page reports this connection type, `false` when the
 * popup closes without that message. Rejects when the flow cannot start.
 */
export async function startGoogleOAuthPopup(
  projectName: string,
  type: GoogleOAuthConnectionType,
  onFinished: (completed: boolean) => void,
): Promise<'popup' | 'redirect'> {
  const { authUrl, redirectUri } = await googleConnect(projectName, type)
  if (!authUrl.startsWith('https://accounts.google.com/')) throw new Error(UNEXPECTED_OAUTH_URL_MESSAGE)

  const popup = window.open(authUrl, '_blank', 'width=600,height=700')
  if (!popup) {
    window.location.assign(authUrl)
    return 'redirect'
  }

  const callbackOrigin = redirectUri ? new URL(redirectUri).origin : window.location.origin
  let finished = false
  const finish = (completed: boolean) => {
    if (finished) return
    finished = true
    window.clearInterval(timer)
    window.removeEventListener('message', handleMessage)
    onFinished(completed)
  }
  function handleMessage(event: MessageEvent) {
    if (event.source !== popup || event.origin !== callbackOrigin) return
    if (!event.data || typeof event.data !== 'object') return
    const message = event.data as { type?: unknown; connectionType?: unknown }
    if (message.type !== GOOGLE_OAUTH_COMPLETE_MESSAGE || message.connectionType !== type) return
    finish(true)
  }
  window.addEventListener('message', handleMessage)
  const timer = window.setInterval(() => {
    if (popup.closed) finish(false)
  }, 1000)
  return 'popup'
}
