import { missingDependency } from '@ainyc/canonry-contracts'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { PLUGIN_DIR, PLUGIN_PKG_JSON } from './constants.js'

export interface PluginResolverOptions {
  pluginPkgJson?: string
}

function pluginDirFor(pkgJson: string): string {
  return path.dirname(pkgJson)
}

function duckdbPkgJsonFor(pluginDir: string): string {
  return path.join(pluginDir, 'node_modules', '@duckdb', 'node-api', 'package.json')
}

export function loadDuckdb(opts: PluginResolverOptions = {}): unknown {
  const pkgJson = opts.pluginPkgJson ?? PLUGIN_PKG_JSON
  const pluginDir = pluginDirFor(pkgJson)
  const duckdbPkg = duckdbPkgJsonFor(pluginDir)

  if (!fs.existsSync(duckdbPkg)) {
    throw missingDependency(
      '@duckdb/node-api is not installed. Run `canonry backlinks install` to enable the backlinks feature.',
      { pluginDir },
    )
  }

  try {
    // Anchor createRequire at the package's own package.json so Node resolves
    // @duckdb/node-api to exactly this copy — not whatever the module-resolution
    // walk-up happens to find (e.g. a devDependency in a parent node_modules).
    const pluginRequire = createRequire(duckdbPkg)
    return pluginRequire('@duckdb/node-api')
  } catch {
    throw missingDependency(
      '@duckdb/node-api is installed but failed to load. Re-run `canonry backlinks install`.',
      { pluginDir },
    )
  }
}

export function isDuckdbInstalled(opts: PluginResolverOptions = {}): boolean {
  const pkgJson = opts.pluginPkgJson ?? PLUGIN_PKG_JSON
  return fs.existsSync(duckdbPkgJsonFor(pluginDirFor(pkgJson)))
}

export function readInstalledVersion(opts: PluginResolverOptions = {}): string | null {
  const pluginDir = opts.pluginPkgJson ? pluginDirFor(opts.pluginPkgJson) : PLUGIN_DIR
  try {
    const raw = fs.readFileSync(duckdbPkgJsonFor(pluginDir), 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
