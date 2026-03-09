# DB Package

`@ainyc/aeo-platform-db` provides the Drizzle ORM schema, database client factory, and auto-migration runner for Canonry.

- **SQLite** for local installations (`canonry init`)
- **Postgres** for cloud deployments
- Same schema, different driver — switch via environment variable

Tables: `projects`, `keywords`, `competitors`, `runs`, `query_snapshots`, `audit_log`, `api_keys`, `usage_counters`.
