import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DUCKDB_SPEC, PLUGIN_DIR, PLUGIN_PKG_JSON } from './constants.js'
import { isDuckdbInstalled, readInstalledVersion } from './plugin-resolver.js'

export interface InstallDuckdbOptions {
  pluginDir?: string
  spec?: string
  packageManager?: 'npm' | 'pnpm'
  onLog?: (line: string) => void
}

export interface InstallDuckdbResult {
  alreadyPresent: boolean
  version: string
  path: string
}

export async function installDuckdb(opts: InstallDuckdbOptions = {}): Promise<InstallDuckdbResult> {
  const pluginDir = opts.pluginDir ?? PLUGIN_DIR
  const pluginPkgJson = path.join(pluginDir, 'package.json')
  const spec = opts.spec ?? DUCKDB_SPEC
  const pkgManager = opts.packageManager ?? 'npm'

  await ensurePluginDir(pluginDir, pluginPkgJson)

  if (isDuckdbInstalled({ pluginPkgJson })) {
    const version = readInstalledVersion({ pluginPkgJson }) ?? 'unknown'
    return { alreadyPresent: true, version, path: pluginDir }
  }

  await runInstall(pkgManager, spec, pluginDir, opts.onLog)

  if (!isDuckdbInstalled({ pluginPkgJson })) {
    throw new Error(`${pkgManager} install completed but @duckdb/node-api still cannot be resolved from ${pluginDir}`)
  }
  const version = readInstalledVersion({ pluginPkgJson }) ?? 'unknown'
  return { alreadyPresent: false, version, path: pluginDir }
}

export async function ensurePluginDir(pluginDir: string = PLUGIN_DIR, pluginPkgJson: string = PLUGIN_PKG_JSON): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true })
  try {
    await fs.access(pluginPkgJson)
  } catch {
    const contents = JSON.stringify({ name: 'canonry-plugins', private: true, dependencies: {} }, null, 2)
    await fs.writeFile(pluginPkgJson, `${contents}\n`)
  }
}

async function runInstall(
  pkgManager: 'npm' | 'pnpm',
  spec: string,
  pluginDir: string,
  onLog?: (line: string) => void,
): Promise<void> {
  const args = pkgManager === 'pnpm'
    ? ['add', spec, '--dir', pluginDir]
    : ['install', spec, '--prefix', pluginDir]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pkgManager, args, {
      stdio: onLog ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    if (onLog) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) onLog(line)
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) onLog(line)
        }
      })
    }
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${pkgManager} install exited with code ${code}`))
    })
  })
}
