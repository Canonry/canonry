import type { FastifyInstance } from 'fastify'

export interface SettingsRoutesOptions {
  geminiModel?: string
  geminiQuota?: {
    maxConcurrency: number
    maxRequestsPerMinute: number
    maxRequestsPerDay: number
  }
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  app.get('/settings', async () => ({
    provider: {
      name: 'Gemini',
      model: opts.geminiModel ?? 'gemini-2.5-flash',
    },
    quota: opts.geminiQuota ?? {
      maxConcurrency: 2,
      maxRequestsPerMinute: 10,
      maxRequestsPerDay: 1000,
    },
  }))
}
