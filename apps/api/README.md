# API App

`@ainyc/aeo-platform-api` is the cloud deployment entry point for the Fastify API. It imports shared route plugins from `packages/api-routes/` and adds cloud-specific configuration (Postgres, pg-boss).

For local use, the same route plugins are mounted by `packages/canonry/src/server.ts`.
