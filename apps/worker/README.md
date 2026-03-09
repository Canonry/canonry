# Worker App

`@ainyc/aeo-platform-worker` is the background job skeleton for the platform. It owns the execution boundary to external systems, including the published `@ainyc/aeo-audit` package for technical audits. Phase 1 keeps that boundary lightweight: startup, heartbeat logging, health reporting, and a concrete audit adapter that future run orchestration can call.
