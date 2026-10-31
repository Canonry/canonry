#!/usr/bin/env node
import fs from 'node:fs'

// Keep installation and the developer installer on the published engine policy.
// This runs before dependencies exist, so it uses only Node built-ins.
const range = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node
const current = process.versions.node.split('.').map(Number)
const supported = /^\d+\.\d+\.\d+$/.test(process.versions.node) && range.split('||').some((branch) => branch.trim().split(/\s+/).every((token) => {
  const match = /^(>=|<)(\d+)(?:\.(\d+)\.(\d+))?$/.exec(token)
  if (!match) throw new Error(`Unsupported Node engine constraint: ${token}`)
  const boundary = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
  const difference = current[0] - boundary[0] || current[1] - boundary[1] || current[2] - boundary[2]
  return match[1] === '>=' ? difference >= 0 : difference < 0
}))

if (!supported) {
  const message = `Node ${process.versions.node} is unsupported. Required: ${range}. Switch with nvm use (see .nvmrc).`
  if (process.env.CANONRY_SKIP_NODE_CHECK === '1') {
    process.stderr.write(`${message} Continuing because CANONRY_SKIP_NODE_CHECK=1.\n`)
  } else {
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}
