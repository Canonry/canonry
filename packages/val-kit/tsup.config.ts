import { defineConfig } from 'tsup'

/**
 * Deno consumes an npm package as BUILT JavaScript — it does not run TypeScript
 * out of `node_modules` — so the kit ships ESM + `.d.ts` even though every
 * consumer is a Deno val. One entry per published subpath.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    visibility: 'src/visibility.ts',
    perception: 'src/perception.ts',
    security: 'src/security.ts',
    storage: 'src/storage.ts',
    jobs: 'src/jobs.ts',
    mcp: 'src/mcp.ts',
    ui: 'src/ui.ts',
    config: 'src/config.ts',
  },
  format: ['esm'],
  // Neutral, not `node`: nothing here touches a Node builtin, and the artifact
  // runs on Deno.
  platform: 'neutral',
  target: 'es2022',
  splitting: true,
  clean: true,
  dts: {
    // tsup's DTS step invokes tsc internally; `incremental` inherited from
    // tsconfig.base.json triggers TS5074 here because there's no emit target
    // and no tsBuildInfoFile in this path. Force it off — typecheck still
    // benefits from incremental via the standalone `typecheck` script.
    compilerOptions: { incremental: false },
  },
  external: ['@google/genai'],
})
