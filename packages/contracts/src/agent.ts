export interface AgentStatusDto {
  /** Whether agent config exists in canonry config.yaml */
  configured: boolean
  /** Gateway runtime state */
  gatewayState: 'running' | 'stopped' | 'needs-setup' | 'unknown'
  port?: number
  sessionKey?: string
}

export interface AgentTranscriptMessageDto {
  /** Stable unique ID from OpenClaw transcript entry */
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** Sequence number in the session (from OpenClaw `seq` field) */
  seq: number
  /** Entry state: delta (streaming partial), final, aborted, error */
  state: 'delta' | 'final' | 'aborted' | 'error'
  /** Channel that originated this message (webchat, telegram, cli, etc.) */
  channel?: string
  toolCalls?: Array<{ name: string; input?: unknown; output?: unknown }>
}

export interface AgentTranscriptDto {
  messages: AgentTranscriptMessageDto[]
  /** Cursor for pagination — pass back as `cursor` param to get next page */
  cursor?: string
  /** ID of the newest message — use for polling dedup */
  lastMessageId?: string
}

export interface AgentChatRequestDto {
  message: string
  context?: {
    page?: string
    insightId?: string
    runId?: string
    projectName?: string
  }
  stream?: boolean
}

export interface AgentChatResponseDto {
  /** Non-streaming response content */
  content: string
  messageId: string
}
