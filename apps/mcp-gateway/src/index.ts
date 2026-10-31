import { readFileSync } from 'node:fs'
import { gatewayConfigSchema, readGatewayEnv } from '@canonry/canonry-config'
import { createGateway } from './server.js'

const secrets = readGatewayEnv(process.env)
const config = gatewayConfigSchema.parse(JSON.parse(readFileSync(secrets.configPath, 'utf8')) as unknown)
const gateway = createGateway(config, secrets, event => { process.stdout.write(JSON.stringify(event) + '\n') })
gateway.server.listen(config.port, config.host, () => {
  process.stdout.write(JSON.stringify({ event: 'gateway_started', issuer: config.issuer }) + '\n')
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void gateway.close().then(() => process.exit(0), () => process.exit(1))
})
