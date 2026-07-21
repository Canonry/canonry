#!/usr/bin/env node
/**
 * Fail the install early, and legibly, on a Node version this repo cannot build.
 *
 * WHY THIS EXISTS
 * `better-sqlite3` is a NATIVE module. On a Node major it has no prebuilt binary
 * for, `pnpm install` falls through to compiling from source and dies in
 * node-gyp with a couple hundred lines of C++ output. Nothing in that wall of
 * text says "wrong Node version", so the reader — very often an agent, which
 * cannot see the terminal scrollback a human would — concludes the repo is
 * broken and starts changing dependencies.
 *
 * The declared `engines.node` range did not help, for two reasons:
 *   - it was unbounded upward (`>=22.14.0`), so it actively asserted that a
 *     brand-new Node major was supported when the native dep had no prebuild;
 *   - pnpm does not enforce `engines` unless `engine-strict` is set, and turning
 *     that on globally would break the Docker build, which runs on node:20 and
 *     therefore sits BELOW the declared floor.
 *
 * So the check lives here instead: keyed to what the native dependency actually
 * supports, which is a superset of both the Docker base and CI.
 *
 * KEEPING THIS HONEST
 * `SUPPORTED_MAJORS` mirrors better-sqlite3's own `engines.node`. It is asserted
 * against the installed package by `packages/db/test/node-support-range.test.ts`,
 * so a dependency bump that widens or narrows support fails a test rather than
 * silently drifting.
 */

// Mirrors better-sqlite3 engines: "20.x || 22.x || 23.x || 24.x || 25.x"
const SUPPORTED_MAJORS = [20, 22, 23, 24, 25]

const major = Number.parseInt(process.versions.node.split('.')[0], 10)
const bypassed = process.env.CANONRY_SKIP_NODE_CHECK === '1'

if (!SUPPORTED_MAJORS.includes(major) && bypassed) {
  process.stderr.write(
    `  ! Node ${process.versions.node} is unsupported; continuing because ` +
      'CANONRY_SKIP_NODE_CHECK=1. A native build failure here is expected.\n',
  )
} else if (!SUPPORTED_MAJORS.includes(major)) {
  const supported = SUPPORTED_MAJORS.join(', ')
  process.stderr.write(
    [
      '',
      '  ✖ Unsupported Node version for this repository.',
      '',
      `      you are running   Node ${process.versions.node}`,
      `      supported majors  ${supported}`,
      '',
      '    This is not a bug in the repo. `better-sqlite3` is a native module and',
      '    ships prebuilt binaries only for the majors above. On anything else the',
      '    install tries to compile from source and fails deep inside node-gyp,',
      '    which looks like an unrelated build error.',
      '',
      '    Fix: switch Node, do NOT change dependencies.',
      `      nvm use 22        (or fnm/volta/asdf — see .nvmrc)`,
      '      CI runs Node 22; the Docker images run Node 20.',
      '',
      '    If you are intentionally testing a newer Node, set',
      '    CANONRY_SKIP_NODE_CHECK=1 to bypass this and expect the native build',
      '    to fail.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
