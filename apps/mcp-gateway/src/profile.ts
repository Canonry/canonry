import type { Tool } from '@modelcontextprotocol/server'

export interface GatewayProfile {
  id: string
  name?: string
  nickname?: string
}

/** Describe the gateway's outer authorization, preserving the upstream business schema. */
export function withGatewaySecurity(tool: Tool): Tool {
  const securitySchemes = [{ type: 'oauth2', scopes: ['read'] }]
  const secured = {
    ...tool,
    securitySchemes,
    _meta: { ...tool._meta, securitySchemes },
  }
  return secured
}

/** Identity-only wrapper: the authenticated binding supplies the persisted opaque ID. */
export const gatewayProfileTool: Tool = withGatewaySecurity({
  name: 'canonry_gateway_profile',
  title: 'Read connected Canonry profile',
  description: 'Return the profile represented by this request\'s authenticated credentials. Its opaque ID is stable across token refresh, reconnection and display-name changes. This tool accepts no workspace or user selection.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Persistent opaque identifier for this authenticated Canonry profile.' },
      name: { type: 'string', description: 'Current display name from the connected Canonry instance.' },
      nickname: { type: 'string', description: 'Workspace label that distinguishes this connection.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { 'openai/profile': true },
})
