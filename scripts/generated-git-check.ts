import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Check Git publication state even when the artifact cache hits. Never write to Git. */
export function assertGeneratedFilesIncluded(outputDir: string, committed = false): void {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: outputDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const root = git(['rev-parse', '--show-toplevel']).trim()
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(outputDir)).split(path.sep).join('/')
  const scope = `:(top,literal)${relative}`
  const changed = git(['diff', '--no-ext-diff', '--name-only', '-z', ...(committed ? ['HEAD'] : []), '--', scope])
  // Include ignored files too: an ignored generated addition is still absent from Git.
  const untracked = git(['ls-files', '--others', '-z', '--', scope])
  const missing = [...new Set(`${changed}${untracked}`.split('\0').filter(Boolean))]
  if (missing.length > 0) {
    throw new Error(`Generated files differ from ${committed ? 'HEAD' : 'the Git index'}:\n${missing.slice(0, 20).join('\n')}\nReview and ${committed ? 'commit' : 'stage'} the generated changes before checking again.`)
  }
}
