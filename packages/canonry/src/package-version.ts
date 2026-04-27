import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

export const PACKAGE_VERSION = (_require('../package.json') as { version: string }).version
