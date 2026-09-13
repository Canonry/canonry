import { CliError, type CliFormat, isMachineFormat } from '../cli-error.js'
import { DEFAULT_DEMO_TRUSTED_PROXIES, trustedProxyProblem } from '../demo/trust-proxy.js'

export function parseDemoListenOptions(options: { port?: string; host?: string }) {
  const rawPort = options.port ?? '4188'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new CliError({ code: 'INVALID_PORT', message: 'Demo port must be an integer between 1 and 65535.', exitCode: 1 })
  }
  const host = options.host ?? '127.0.0.1'
  if (!host.trim() || /[\s/]/.test(host)) {
    throw new CliError({ code: 'INVALID_HOST', message: 'Demo host must be an IP address or hostname.', exitCode: 1 })
  }
  return { host, port }
}

/** Proxies allowed to report the visitor address. Named values replace the loopback default. */
export function parseDemoTrustedProxies(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [...DEFAULT_DEMO_TRUSTED_PROXIES]
  for (const value of values) {
    const problem = trustedProxyProblem(value)
    if (problem) {
      throw new CliError({ code: 'INVALID_TRUST_PROXY', message: `--trust-proxy ${JSON.stringify(value)} ${problem}.`, details: { value }, exitCode: 1 })
    }
  }
  return [...values]
}

export async function demoCommand(options: { port?: string; host?: string; trustProxy?: readonly string[]; format?: CliFormat }) {
  const { host, port } = parseDemoListenOptions(options)
  const trustProxy = parseDemoTrustedProxies(options.trustProxy)
  const { createDemoServer } = await import('../demo-server.js')
  const app = await createDemoServer({ trustProxy })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void app.close().catch(() => { process.exitCode = 1 })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  app.addHook('onClose', async () => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  })
  try {
    await app.listen({ host, port })
  } catch (error) {
    await app.close()
    throw error
  }
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  const result = { status: 'ready', mode: 'view-only', sampleData: true, url }
  if (isMachineFormat(options.format ?? 'text')) console.log(JSON.stringify(result))
  else console.log(`Canonry view-only demo: ${url}\nFictional sample data. No provider calls or background runs. Ctrl+C to stop.`)
}
