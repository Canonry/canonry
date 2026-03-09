# Worker App

`@ainyc/aeo-platform-worker` is the cloud deployment entry point for background job processing. It owns the execution boundary to external systems, including the published `@ainyc/aeo-audit` package for technical audits and `packages/provider-gemini` for visibility queries.

For local use, job execution is handled in-process by `packages/canonry/src/job-runner.ts`.
