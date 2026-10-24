import { useId, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { HostedMcpStatuses, HostedMcpUnavailableReasons, McpTransportStatuses, type HostedMcpUnavailableReason, type UiAction } from '@canonry/canonry-contracts'

import { getPublicBase, isEmbed, isPublicDemo, shouldShowDashboardLocalAgentSetup, shouldShowDashboardResourceLinks } from '../api.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useAccount } from '../contexts/account-context.js'
import { useHealth } from '../queries/use-health.js'
import { asyncHandler } from '../lib/async-handler.js'
import { trackUiAction } from '../lib/ui-telemetry.js'
import { Button } from '../components/ui/button.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'

const MCP_GUIDE = 'https://github.com/Canonry/canonry/blob/main/docs/mcp.md'
const PLUGIN_GUIDE = 'https://github.com/Canonry/canonry/blob/main/docs/plugins.md'
const CHATGPT_GUIDE = 'https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt'
const CLAUDE_GUIDE = 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp'

const HOSTED_REQUIREMENTS: Record<HostedMcpUnavailableReason, string> = {
  [HostedMcpUnavailableReasons['public-url-required']]: 'Configure this instance’s public URL before connecting a hosted client.',
  [HostedMcpUnavailableReasons['https-required']]: 'Configure an HTTPS public URL for this instance.',
  [HostedMcpUnavailableReasons['public-host-required']]: 'Use a public HTTPS address that your client can reach. Localhost and private-network addresses do not work for hosted connectors.',
  [HostedMcpUnavailableReasons['public-path-mismatch']]: 'Make the publicUrl path match basePath, and preserve that prefix when the proxy forwards requests for hosted OAuth.',
  [HostedMcpUnavailableReasons['oauth-unavailable']]: 'The sign-in routes are unavailable. Check this instance’s OAuth configuration.',
  [HostedMcpUnavailableReasons['account-required']]: 'Create a named Canonry account on this instance’s server with canonry user create. A shared dashboard password does not provide an OAuth account.',
  [HostedMcpUnavailableReasons['transport-unavailable']]: 'Restore the instance’s HTTP MCP service before connecting a hosted client.',
}

const LOCAL_CLIENTS = {
  codex: {
    label: 'Codex',
    command: 'codex plugin marketplace add Canonry/canonry\ncodex plugin add canonry@canonry',
  },
  claude: {
    label: 'Claude Code',
    command: 'claude plugin marketplace add Canonry/canonry\nclaude plugin install canonry@canonry',
  },
  other: {
    label: 'Other MCP clients',
    command: 'canonry-mcp',
  },
} as const

function CopyText({ label, value, showText = false, secondary = false, action = 'agent_setup.copy' }: { label: string; value: string; showText?: boolean; secondary?: boolean; action?: UiAction }) {
  const id = useId()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      trackUiAction(action)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      {showText ? <pre className="overflow-x-auto rounded-md border border-default bg-bg p-3 text-sm text-heading"><code>{value}</code></pre> : null}
      <Button type="button" className="min-h-11" variant={secondary ? 'outline' : 'default'} onClick={asyncHandler(copy)}>
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {label}
      </Button>
      {copied ? <p role="status" className="text-sm text-secondary">Copied.</p> : null}
      {!showText || copyFailed ? (
        <details open={copyFailed || undefined} className="text-sm text-secondary">
          <summary className="min-h-11 w-fit cursor-pointer py-3">{copyFailed ? 'Copy unavailable. Select the text below.' : 'Preview text'}</summary>
          <label htmlFor={id} className="sr-only">{label} text</label>
          <textarea id={id} readOnly rows={copyFailed && showText ? 3 : 8} value={value} className="mt-2 w-full rounded-md border border-default bg-bg p-3 text-sm leading-6 text-heading" />
        </details>
      ) : null}
    </div>
  )
}

/** Connect an existing instance; the first-site setup prompt remains on /setup. */
export function AgentSetupPage() {
  if (isEmbed() || isPublicDemo()) {
    return (
      <div className="page-container">
        <h1 className="page-title">Agent setup</h1>
        <p className="mt-3 text-sm text-secondary">Open Agent setup in your own Canonry instance to connect your agent.</p>
        {shouldShowDashboardResourceLinks() ? <a className="mt-4 inline-block text-sm underline" href={MCP_GUIDE} target="_blank" rel="noopener noreferrer">Read the connection guide</a> : null}
      </div>
    )
  }
  return <AgentConnectionSetup />
}

function AgentConnectionSetup() {
  const initial = useInitialDashboard()
  const { isAdmin } = useAccount()
  const showLocalAgentSetup = shouldShowDashboardLocalAgentSetup()
  const showResourceLinks = shouldShowDashboardResourceLinks()
  const health = useHealth(!initial, initial?.health)
  const apiStatus = health.data?.apiStatus
  const mcp = apiStatus?.state === 'ok' ? apiStatus.mcp : undefined
  const hosted = mcp?.status === McpTransportStatuses.available && mcp.hosted?.status === HostedMcpStatuses.ready ? mcp.hosted : undefined
  const requirement = mcp?.hosted?.status === HostedMcpStatuses.unavailable ? mcp.hosted.reason : undefined
  const instanceUrl = `${window.location.origin}${getPublicBase()}`
  let requirementMessage = 'This server has not confirmed a public URL and OAuth sign-in. Ask your administrator to check the connection configuration or update Canonry.'
  if (health.isPending) {
    requirementMessage = 'Checking the instance’s hosted connection settings.'
  } else if (requirement) {
    requirementMessage = isAdmin && showLocalAgentSetup ? HOSTED_REQUIREMENTS[requirement] : 'Ask your Canonry administrator to finish hosted connection setup for this instance.'
  } else if (apiStatus?.state === 'error') {
    requirementMessage = 'The instance’s connection settings could not be checked. Try again after the service is available.'
  } else if (mcp?.status === McpTransportStatuses['not-supported']) {
    requirementMessage = 'This deployment does not provide hosted MCP connections. Ask your administrator for a supported connection.'
  }
  const setupPrompt = hosted ? `Help me connect this existing Canonry instance to ChatGPT or Claude Desktop using its remote MCP URL: ${hosted.url}

Use the client's remote MCP connection flow with OAuth sign-in. For Claude, choose Register automatically if asked how to register the OAuth client. Have me sign in to Canonry in the browser and review the requested access before approving it. Keep passwords, API keys, browser sessions, and other credentials out of chat. Do not install software, run local commands, create another instance, or broaden access.

ChatGPT guide: ${CHATGPT_GUIDE}
Claude guide: ${CLAUDE_GUIDE}

After authorization, enable the connection in this conversation. Call canonry_help with intent "status", follow its available tool guidance, and list accessible projects using stored reads only. Confirm the target instance and report whether the read succeeded; an empty list can still mean success. Do not run scans, sweeps, research, live provider checks, or other writes.` : undefined

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Agent setup</h1>
          <p className="page-subtitle">{showLocalAgentSetup ? 'Connect ChatGPT, Claude Desktop, or another agent to this instance.' : 'Connect ChatGPT or Claude Desktop to this instance.'}</p>
        </div>
      </div>

      <div className="max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-heading">Your Canonry instance</p>
            <p className="mt-1 break-all text-sm text-secondary">{instanceUrl}</p>
          </div>
          <ToneBadge tone={hosted ? 'positive' : requirement || apiStatus?.state === 'error' ? 'caution' : 'neutral'}>
            {hosted ? 'Hosted setup configured' : health.isPending ? 'Checking hosted setup' : requirement ? 'Hosted setup needs attention' : 'Hosted setup not confirmed'}
          </ToneBadge>
        </div>

        {hosted && setupPrompt ? (
          <>
            <section className="py-6" aria-labelledby="agent-connect-title">
              <h2 id="agent-connect-title" className="text-lg font-semibold text-heading">1. Add Canonry to your client</h2>
              <p className="mt-2 mb-4 max-w-prose text-sm leading-6 text-secondary">Add this URL to your client’s remote connector settings. No local installation is needed.</p>
              <CopyText key={hosted.url} label="Copy MCP URL" value={hosted.url} showText />
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm leading-6 text-secondary">
                <a href={CHATGPT_GUIDE} target="_blank" rel="noopener noreferrer" className="underline">ChatGPT setup guide</a>
                <a href={CLAUDE_GUIDE} target="_blank" rel="noopener noreferrer" className="underline">Claude Desktop setup guide</a>
              </div>
              <p className="mt-2 text-sm leading-6 text-secondary">Choose OAuth authentication and “Register automatically” if asked.</p>
              <div className="mt-4"><CopyText key={setupPrompt} label="Copy setup prompt" value={setupPrompt} secondary /></div>
            </section>

            <section className="border-t border-default py-6" aria-labelledby="agent-authorize-title">
              <h2 id="agent-authorize-title" className="text-lg font-semibold text-heading">2. Sign in and approve access</h2>
              <p className="mt-2 max-w-prose text-sm leading-6 text-secondary">Sign in with your Canonry account and review the requested access. After approving it, return to your client and enable the connection for your conversation.</p>
            </section>

            <section className="border-t border-default py-6" aria-labelledby="agent-verify-title">
              <h2 id="agent-verify-title" className="text-lg font-semibold text-heading">3. Verify the connection</h2>
              <p className="mt-2 mb-4 max-w-prose text-sm leading-6 text-secondary">Server configuration is ready. Use this prompt to confirm your agent can read your projects without starting work or using provider quota.</p>
              <VerificationPrompt target={hosted.url} />
            </section>
          </>
        ) : (
          <section className="py-6" aria-labelledby="agent-requirements-title">
            <h2 id="agent-requirements-title" className="text-lg font-semibold text-heading">Before you connect a hosted client</h2>
            <p className="mt-2 max-w-prose text-sm leading-6 text-secondary">
              {requirementMessage}
            </p>
            {showResourceLinks ? <a href={MCP_GUIDE} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm underline">Read the connection guide <ExternalLink className="size-3.5" aria-hidden="true" /></a> : null}
          </section>
        )}

        {showLocalAgentSetup ? <LocalConnectionSetup instanceUrl={instanceUrl} showResourceLinks={showResourceLinks} /> : null}
      </div>
    </div>
  )
}

function VerificationPrompt({ target, local = false }: { target: string; local?: boolean }) {
  const prompt = `Verify my existing Canonry connection targets ${target}. Call canonry_help with intent "status", follow its available tool guidance, then list accessible projects using stored reads only. Report the instance, connection method, and whether the project read succeeded. An empty project list can still be a successful connection. If the target cannot be confirmed, stop and explain. Do not install anything, change configuration, create projects, run scans, sweeps, research, or live provider checks.`
  return <CopyText key={target} label={local ? 'Copy local verification prompt' : 'Copy verification prompt'} value={prompt} secondary action="agent_setup.verify_copy" />
}

function LocalConnectionSetup({ instanceUrl, showResourceLinks }: { instanceUrl: string; showResourceLinks: boolean }) {
  const [client, setClient] = useState<keyof typeof LOCAL_CLIENTS>('codex')
  const resources = showResourceLinks ? `Official connection guide: ${MCP_GUIDE}
Optional plugin guide for Codex or Claude Code: ${PLUGIN_GUIDE}

` : ''
  const prompt = `Connect my local agent to this existing Canonry instance: ${instanceUrl}

Use an installed Canonry runtime whose private configuration already points to this exact instance. A local plugin or canonry-mcp process does not inherit the browser connection, and shell environment changes do not retarget an already-connected tool. Check the saved API URL before using it.

${resources}Preserve existing client connections, credentials, and access. Do not create another Canonry instance, bootstrap a config, or create projects. Keep secrets and configuration contents out of chat. Ask before changing client configuration or installing software. Reload the client if needed, then verify with stored reads only. Do not run scans, sweeps, research, live provider checks, or other writes.`
  return (
    <details className="border-t border-default py-3 text-sm">
      <summary className="min-h-11 w-fit cursor-pointer py-3 font-medium text-heading">Local plugins and other MCP clients</summary>
      <div className="space-y-4 py-4">
        <p className="max-w-prose leading-6 text-secondary">For an agent running on your computer, use a Canonry runtime whose private configuration already points to this instance. The plugin does not inherit your browser connection.</p>
        <CopyText label="Copy local setup prompt" value={prompt} secondary />
        <label className="block font-medium text-heading" htmlFor="agent-client">Your client</label>
        <select id="agent-client" className="h-11 max-w-full rounded-md border border-default bg-bg px-3 text-sm text-heading" value={client} onChange={event => {
          const value = event.target.value
          if (value === 'codex' || value === 'claude' || value === 'other') setClient(value)
        }}>
          {Object.entries(LOCAL_CLIENTS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
        </select>
        <CopyText key={client} label={client === 'other' ? 'Copy MCP command' : 'Copy install commands'} value={LOCAL_CLIENTS[client].command} showText secondary />
        <p className="leading-6 text-secondary">{client === 'other' ? 'Add this executable as a stdio MCP server in your client.' : 'Reload your client after installing the plugin.'} Keep one Canonry connection per instance.</p>
        {showResourceLinks ? <a href={PLUGIN_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 underline">Runtime and plugin instructions <ExternalLink className="size-3.5" aria-hidden="true" /></a> : null}
        <VerificationPrompt target={instanceUrl} local />
      </div>
    </details>
  )
}
