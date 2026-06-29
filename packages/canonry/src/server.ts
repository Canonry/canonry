import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as {
  version: string;
};
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SetHeadersResponse } from "@fastify/static";
import { apiRoutes } from "@ainyc/canonry-api-routes";
import {
  apiKeys,
  auditLog,
  projects,
  runs,
  extractLegacyCredentials,
  dropLegacyCredentialColumns,
  type DatabaseClient,
  type LegacyCredentialRows,
} from "@ainyc/canonry-db";
import os from "node:os";
import {
  embedQueries as embedGeminiQueries,
  extractSearchQueriesFromRaw,
  geminiAdapter,
} from "@ainyc/canonry-provider-gemini";
import { openaiAdapter } from "@ainyc/canonry-provider-openai";
import { claudeAdapter } from "@ainyc/canonry-provider-claude";
import { localAdapter } from "@ainyc/canonry-provider-local";
import { cdpChatgptAdapter } from "@ainyc/canonry-provider-cdp";
import { perplexityAdapter } from "@ainyc/canonry-provider-perplexity";
import {
  authInvalid,
  authRequired,
  validationError,
  buildEmbedClientConfig,
  frameAncestorsHeaderValue,
  CcReleaseSyncStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type ProviderAdapter,
} from "@ainyc/canonry-contracts";
import type { CanonryConfig, ProviderConfigEntry } from "./config.js";
import { resolveEmbedConfig } from "./embed.js";
import { resolveAgentEnabled } from "./agent-config.js";
import { saveConfigPatch, loadConfig, getConfigPath } from "./config.js";
import { getPlacesConfig } from "./places-config.js";
import {
  getGoogleAuthConfig,
  getGoogleConnection,
  listGoogleConnections,
  patchGoogleConnection,
  removeGoogleConnection,
  setGoogleAuthConfig,
  upsertGoogleConnection,
} from "./google-config.js";
import {
  getGa4Connection,
  upsertGa4Connection,
  removeGa4Connection,
} from "./ga4-config.js";
import {
  getCloudRunConnection,
  upsertCloudRunConnection,
  removeCloudRunConnection,
} from "./cloud-run-config.js";
import {
  getWordpressTrafficConnection,
  upsertWordpressTrafficConnection,
  removeWordpressTrafficConnection,
} from "./wordpress-traffic-config.js";
import {
  getVercelTrafficConnection,
  upsertVercelTrafficConnection,
  removeVercelTrafficConnection,
} from "./vercel-traffic-config.js";
import {
  getCloudflareTrafficConnection,
  getCloudflareTrafficConnectionBySourceId,
  upsertCloudflareTrafficConnection,
  removeCloudflareTrafficConnection,
} from "./cloudflare-traffic-config.js";
import { buildCloudflareIngestUrlTemplate } from "./cloudflare-ingest-url.js";
import {
  getWordpressConnection,
  patchWordpressConnection,
  removeWordpressConnection,
  upsertWordpressConnection,
} from "./wordpress-config.js";
import {
  isTelemetryEnabled,
  getOrCreateAnonymousId,
  trackEvent,
} from "./telemetry.js";
import { checkLatestVersionForServer } from "./update-check.js";
import { JobRunner } from "./job-runner.js";
import { executeGscSync } from "./gsc-sync.js";
import { executeGbpSync } from "./gbp-sync.js";
import { executeAdsSync } from "./ads-sync.js";
import {
  getOpenAiAdsConnection,
  upsertOpenAiAdsConnection,
  removeOpenAiAdsConnection,
} from "./ads-config.js";
import { getAdAccount } from "@ainyc/canonry-integration-openai-ads";
import { executeInspectSitemap } from "./gsc-inspect-sitemap.js";
import { executeBingInspectSitemap } from "./bing-inspect-sitemap.js";
import { maybeRefreshGscCoverage } from "./coverage-refresh.js";
import { executeReleaseSync } from "./commoncrawl-sync.js";
import { executeBacklinkExtract } from "./backlink-extract.js";
import { executeBingBacklinkSync } from "./bing-backlinks-sync.js";
import { executeDiscoveryRun } from "./discovery-run.js";
import { executeSiteAudit } from "./execute-site-audit.js";
import { backfillProjectAnswerMentions } from "./commands/backfill.js";
import { getBundledSkillSnapshots } from "./commands/skills.js";
import {
  DUCKDB_SPEC,
  PLUGIN_DIR,
  installDuckdb,
  isDuckdbInstalled,
  listCachedReleases as listCachedReleasesFromDisk,
  probeLatestRelease,
  pruneCachedRelease,
  readInstalledVersion,
} from "@ainyc/canonry-integration-commoncrawl";
import {
  ccReleaseSyncs as ccReleaseSyncsTable,
  projects as projectsTable,
} from "@ainyc/canonry-db";
import { ProviderRegistry } from "./provider-registry.js";
import { Scheduler } from "./scheduler.js";
import { refreshAllIntegrations } from "./data-refresh.js";
import { Notifier } from "./notifier.js";
import { IntelligenceService } from "./intelligence-service.js";
import { RunCoordinator } from "./run-coordinator.js";
import { SessionRegistry } from "./agent/session-registry.js";
import { buildAgentProvidersResponse } from "./agent/providers.js";
import { registerAgentRoutes } from "./agent/agent-routes.js";
import {
  createRecommendationExplainer,
  createRecommendationBriefSynthesizer,
  RECOMMENDATION_BRIEF_PROMPT_VERSION,
} from "./agent/recommendation-explainer.js";
import { ApiClient } from "./client.js";
import { SnapshotService } from "./snapshot-service.js";
import { fetchSiteText } from "./site-fetch.js";
import { createLogger } from "./logger.js";

const log = createLogger("Server");

const DEFAULT_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 1000,
};

const SESSION_COOKIE_NAME = "canonry_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionRecord {
  apiKeyId: string;
  expiresAt: number;
}

/** All known API adapters — add new providers here */
const API_ADAPTERS: ProviderAdapter[] = [
  geminiAdapter,
  openaiAdapter,
  claudeAdapter,
  localAdapter,
  perplexityAdapter,
];

/** All known browser (CDP) adapters */
const BROWSER_ADAPTERS: ProviderAdapter[] = [cdpChatgptAdapter];

const adapterMap = Object.fromEntries(
  API_ADAPTERS.map((a) => [a.name, a]),
) as Record<string, ProviderAdapter>;

function summarizeProviderConfig(config: ProviderConfigEntry | undefined) {
  return {
    configured: Boolean(config?.apiKey || config?.baseUrl),
    model: config?.model ?? null,
    // baseUrl is surfaced for ALL providers, not just local — gemini/openai now
    // honor a custom endpoint, so repointing one must show in the settings
    // summary AND produce an audit diff. Omitting it for API providers would let
    // an endpoint redirect (a credential-exfiltration vector on a box where the
    // provider key is the carrier) happen with no audit trail.
    baseUrl: config?.baseUrl ?? null,
    quota: { ...(config?.quota ?? DEFAULT_QUOTA) },
  };
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Dashboard password storage uses scrypt (salted, slow KDF) — not plain
// SHA-256. The bearer-token path above still hashes with SHA-256 because
// those are 128-bit random `cnry_…` tokens (no brute-force exposure on a
// 64-hex hash). Dashboard passwords are user-chosen and may be reused from
// elsewhere, so a leaked `config.yaml` must not be trivially cracked
// against a wordlist.
//
// Stored format: `scrypt$1$<base64-salt>$<base64-hash>`. The version field
// (`1`) lets future code rotate to a stronger KDF without breaking existing
// installs. Legacy 64-hex SHA-256 hashes are still accepted at login time
// (see `verifyDashboardPassword`); when one matches, the caller writes the
// fresh scrypt-format hash back into the config so the next login no longer
// needs the legacy fallback.
const DASHBOARD_SCRYPT_KEYLEN = 64;
const DASHBOARD_SCRYPT_COST = 1 << 15; // N=32768 — ~80ms on a modern laptop
// Node's default scrypt `maxmem` is 32 MiB which is exactly at the boundary
// for our chosen N (128 * 32768 * 8 ≈ 32 MiB). Bump to 64 MiB to leave
// headroom and keep the derivation comfortably within the limit.
const DASHBOARD_SCRYPT_MAXMEM = 64 * 1024 * 1024;

function hashDashboardPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, DASHBOARD_SCRYPT_KEYLEN, {
    N: DASHBOARD_SCRYPT_COST,
    maxmem: DASHBOARD_SCRYPT_MAXMEM,
  });
  return `scrypt$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

interface DashboardPasswordVerifyResult {
  ok: boolean;
  needsRehash: boolean;
}

function verifyDashboardPassword(
  password: string,
  storedHash: string,
): DashboardPasswordVerifyResult {
  // New format: scrypt with salt.
  if (storedHash.startsWith("scrypt$1$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 4) return { ok: false, needsRehash: false };
    const saltB64 = parts[2];
    const hashB64 = parts[3];
    if (!saltB64 || !hashB64) return { ok: false, needsRehash: false };
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(saltB64, "base64");
      expected = Buffer.from(hashB64, "base64");
    } catch {
      return { ok: false, needsRehash: false };
    }
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: DASHBOARD_SCRYPT_COST,
      maxmem: DASHBOARD_SCRYPT_MAXMEM,
    });
    if (derived.length !== expected.length)
      return { ok: false, needsRehash: false };
    return {
      ok: crypto.timingSafeEqual(derived, expected),
      needsRehash: false,
    };
  }

  // Legacy SHA-256 hex format — accept once for migration, then rehash.
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const candidate = Buffer.from(hashApiKey(password), "hex");
    const expected = Buffer.from(storedHash, "hex");
    if (candidate.length !== expected.length)
      return { ok: false, needsRehash: false };
    const ok = crypto.timingSafeEqual(candidate, expected);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) return cookies;
      const name = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (!name) return cookies;
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function serializeSessionCookie(opts: {
  name: string;
  value: string | null;
  path: string;
  secure: boolean;
  ttlMs: number;
}): string {
  const parts = [
    `${opts.name}=${opts.value ? encodeURIComponent(opts.value) : ""}`,
    `Path=${opts.path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (opts.value) {
    parts.push(`Max-Age=${Math.floor(opts.ttlMs / 1000)}`);
  } else {
    parts.push("Max-Age=0");
  }

  if (opts.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

/**
 * One-time migration: persist Google OAuth tokens and GA4 service account keys
 * extracted from the legacy DB columns into config.yaml. Skips any connection
 * that already exists in config to avoid overwriting refreshed tokens.
 *
 * Pair with `extractLegacyCredentials(db)` + `dropLegacyCredentialColumns(db)`
 * from `@ainyc/canonry-db`: extract first, call this, and only drop the columns
 * once this returns — a failed config write must be retryable on next boot.
 */
export function applyLegacyCredentials(
  rows: LegacyCredentialRows,
  config: CanonryConfig,
): void {
  let migratedGoogle = 0;
  for (const row of rows.google) {
    const existing = getGoogleConnection(
      config,
      row.domain,
      row.connectionType,
    );
    if (existing?.refreshToken) continue;
    upsertGoogleConnection(config, {
      domain: row.domain,
      connectionType: row.connectionType,
      propertyId: row.propertyId,
      sitemapUrl: row.sitemapUrl,
      accessToken: row.accessToken ?? undefined,
      refreshToken: row.refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
      scopes: row.scopes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    migratedGoogle++;
  }
  if (migratedGoogle > 0) {
    saveConfigPatch({ google: config.google });
    log.info("credentials.migrated", { type: "google", count: migratedGoogle });
  }

  let migratedGa4 = 0;
  for (const row of rows.ga4) {
    const existing = getGa4Connection(config, row.projectName);
    if (existing?.privateKey) continue;
    upsertGa4Connection(config, {
      projectName: row.projectName,
      propertyId: row.propertyId,
      clientEmail: row.clientEmail,
      privateKey: row.privateKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    migratedGa4++;
  }
  if (migratedGa4 > 0) {
    saveConfigPatch({ ga4: config.ga4 });
    log.info("credentials.migrated", { type: "ga4", count: migratedGa4 });
  }
}

/**
 * Whether `host` is a loopback bind — only the local machine can reach a
 * server bound here. `undefined` (programmatic/test callers that never bind a
 * socket) is treated as loopback. `0.0.0.0` / `::` (bind-all) and any specific
 * LAN/public address are NOT loopback.
 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (host == null || host === "") return true;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  // IPv4 loopback is the whole 127.0.0.0/8 block.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  return false;
}

export async function createServer(opts: {
  config: CanonryConfig;
  db: DatabaseClient;
  open?: boolean;
  logger?: boolean;
  /**
   * The network interface the server will bind to (from `canonry serve`).
   * Used to gate the unauthenticated first-run dashboard password setup: on a
   * loopback bind only local processes can reach `/session/setup`, so claiming
   * the initial password without the API key is safe. On a non-loopback bind
   * (`0.0.0.0`, a LAN IP) the setup endpoint additionally requires a valid
   * bearer key so a remote first-visitor cannot mint a full-access session.
   * Defaults to loopback when unset (programmatic/test callers).
   */
  host?: string;
  /**
   * Override for the directory the pre-built SPA is served from. Defaults to
   * the package's bundled `assets/` (resolved from `import.meta.url`). Exposed
   * so tests can point at a temp dir containing a fixture `index.html` and
   * assert the injected config + framing header on the served document.
   */
  assetsDir?: string;
}): Promise<FastifyInstance> {
  const logger =
    opts.logger === false
      ? false
      : process.stdout.isTTY
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "HH:MM:ss",
                ignore: "pid,hostname,reqId",
                messageFormat: "{msg} {req.method} {req.url}",
              },
            },
          }
        : true;

  const app = Fastify({
    logger,
  });

  // Build provider registry from config (with legacy field migration)
  const registry = new ProviderRegistry();
  const providers = opts.config.providers ?? {};

  // Migrate legacy geminiApiKey if providers.gemini is not set
  if (opts.config.geminiApiKey && !providers.gemini) {
    providers.gemini = {
      apiKey: opts.config.geminiApiKey,
      model: opts.config.geminiModel,
      quota: opts.config.geminiQuota,
    };
  }

  // One-time upgrade for pre-1.45.1 installs. Order is load-bearing: extract
  // into memory, persist to config.yaml, and only then drop the legacy columns.
  // Dropping before a successful config write would lose credentials if the
  // disk write fails. Best-effort — any failure is logged and retried next
  // boot rather than blocking server startup.
  try {
    const legacyRows = extractLegacyCredentials(opts.db);
    applyLegacyCredentials(legacyRows, opts.config);
    dropLegacyCredentialColumns(opts.db);
  } catch (err) {
    log.warn("credentials.migration.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("providers.configured", {
    providers: Object.keys(providers).filter((k) => {
      const p = providers[k];
      return p?.apiKey || p?.baseUrl || p?.vertexProject;
    }),
  });

  // Register API providers from config
  for (const adapter of API_ADAPTERS) {
    const entry = providers[adapter.name];
    if (!entry) continue;
    // Local provider requires baseUrl; Gemini can use apiKey OR vertexProject; others require apiKey
    const isConfigured =
      adapter.name === "local"
        ? !!entry.baseUrl
        : adapter.name === "gemini"
          ? !!(entry.apiKey || entry.vertexProject)
          : !!entry.apiKey;
    if (isConfigured) {
      registry.register(adapter, {
        provider: adapter.name,
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl,
        model: entry.model,
        quotaPolicy: entry.quota ?? DEFAULT_QUOTA,
        vertexProject: entry.vertexProject,
        vertexRegion: entry.vertexRegion,
        vertexCredentials: entry.vertexCredentials,
      });
    }
  }

  // CDP browser provider — connects to user's Chrome via CDP
  const cdpConfig = opts.config.cdp;
  if (cdpConfig?.host || cdpConfig?.port) {
    const CDP_DEFAULT_QUOTA = {
      maxConcurrency: 1,
      maxRequestsPerMinute: 4,
      maxRequestsPerDay: 200,
    };
    const cdpEndpoint = `ws://${cdpConfig.host ?? "localhost"}:${cdpConfig.port ?? 9222}`;
    registry.register(cdpChatgptAdapter, {
      provider: "cdp:chatgpt",
      cdpEndpoint,
      quotaPolicy: cdpConfig.quota ?? CDP_DEFAULT_QUOTA,
    });
  }

  const port = opts.config.port ?? 4100;
  const serverUrl = `http://localhost:${port}`;

  const jobRunner = new JobRunner(opts.db, registry);
  jobRunner.recoverStaleRuns();
  const notifier = new Notifier(opts.db, serverUrl);
  const intelligenceService = new IntelligenceService(opts.db);
  // Build the Aero ApiClient from the in-memory server config rather than
  // loadConfig() so tests that set CANONRY_CONFIG_DIR after spawning the
  // server don't fail at construction time.
  const aeroClient = new ApiClient(opts.config.apiUrl, opts.config.apiKey, {
    skipProbe: true,
  });
  // Built-in Aero agent kill-switch. When disabled (config `agent.mode:
  // 'disabled'` or env CANONRY_AGENT_DISABLED=1) we skip the SessionRegistry,
  // the proactive wake on run completion, and the interactive agent routes —
  // the data/intelligence/notification pipeline is unaffected. `aeroClient`
  // itself stays: the scheduler callbacks below reuse it (data-refresh,
  // traffic, backlinks), which is unrelated to Aero.
  const agentEnabled = resolveAgentEnabled(process.env, opts.config);
  const sessionRegistry = agentEnabled
    ? new SessionRegistry({
        db: opts.db,
        client: aeroClient,
        config: opts.config,
      })
    : undefined;

  const runCoordinator = new RunCoordinator(
    opts.db,
    notifier,
    intelligenceService,
    (runId, projectId, result) =>
      notifier.dispatchInsightWebhooks(runId, projectId, result),
    async (ctx) => {
      // Aero kill-switch: never wake the agent on run completion when disabled.
      if (!sessionRegistry) return;
      const project = opts.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, ctx.projectId))
        .get();
      if (!project) return;

      let content: string;
      if (ctx.kind === RunKinds["aeo-discover-probe"]) {
        if (ctx.status === "failed") {
          content =
            `[system] Discovery run ${ctx.runId} failed for project ${project.name}: ${ctx.error ?? "unknown error"}. ` +
            `Surface a one-line diagnosis and a suggested next step.`;
        } else {
          const top =
            ctx.topCompetitors
              .map((c) => `${c.domain}(${c.hits})`)
              .join(", ") || "none";
          content =
            `[system] Discovery run ${ctx.runId} completed for project ${project.name} (session ${ctx.sessionId}). ` +
            `Buckets — cited:${ctx.buckets.cited}, wasted-surface:${ctx.buckets["wasted-surface"]}, aspirational:${ctx.buckets.aspirational} ` +
            `(${ctx.probeCount} probes; seed provider: ${ctx.seedProvider ?? "unknown"}). Top recurring competitor domains: ${top}. ` +
            `Use canonry_discover_session_get to pull per-query buckets and call out cited + aspirational findings worth promoting. Keep it tight.`;
        }
      } else {
        content =
          `[system] Run ${ctx.runId} completed for project ${project.name}. ` +
          `${ctx.insightCount} insights generated (${ctx.criticalOrHigh} critical/high). ` +
          `Use canonry_run_get to inspect the run and canonry_insights_list to review new findings. ` +
          `Surface anything notable briefly — skip chit-chat.`;
      }

      sessionRegistry.queueFollowUp(project.name, {
        role: "user",
        content,
        timestamp: Date.now(),
      });
      // Fire-and-forget drain — the registry logs drain errors internally.
      void sessionRegistry.drainNow(project.name);
    },
  );
  jobRunner.onRunCompleted = (runId, projectId) =>
    runCoordinator.onRunCompleted(runId, projectId);
  const snapshotService = new SnapshotService(registry);

  // OpenClaw gateway was removed in the native-agent-loop rewrite. If the user
  // previously ran `canonry agent setup`, warn once so they know the state dir
  // is orphaned and safe to delete.
  const orphanedOpenClawDir = path.join(os.homedir(), ".openclaw-aero");
  if (fs.existsSync(orphanedOpenClawDir)) {
    app.log.warn(
      { path: orphanedOpenClawDir },
      "OpenClaw gateway is no longer used. Remove ~/.openclaw-aero/ manually to reclaim the directory.",
    );
  }

  // Shared GBP-sync worker entry point. Used by BOTH the manual
  // `POST /gbp/sync` route hook and the scheduled `gbp-sync` kind, so the run
  // row → executeGbpSync → post-run pipeline path is identical for both. The
  // run row is created by the caller (route handler / scheduler); this only
  // runs the sync and hands off to the post-run coordinator on completion.
  const runGbpSync = (
    runId: string,
    projectId: string,
    syncOpts?: {
      locationNames?: string[];
      daysOfMetrics?: number;
      monthsOfKeywords?: number;
    },
  ): void => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } =
      getGoogleAuthConfig(opts.config);
    if (!googleClientId || !googleClientSecret) {
      app.log.error(
        "GBP sync requested but Google OAuth credentials are not configured in the local config",
      );
      return;
    }
    executeGbpSync(opts.db, runId, projectId, {
      ...syncOpts,
      config: opts.config,
    })
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch((err: unknown) => {
        app.log.error({ runId, err }, "GBP sync failed");
      });
  };

  // Shared ads-sync worker entry point. Used by the scheduled `ads-sync`
  // kind today and the manual ads sync route when it lands; the run row is
  // created by the caller (scheduler / route handler), this only runs the
  // sync and hands off to the post-run coordinator on completion.
  const runAdsSync = (runId: string, projectId: string): void => {
    executeAdsSync(opts.db, runId, projectId, { config: opts.config })
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch((err: unknown) => {
        app.log.error({ runId, err }, "Ads sync failed");
      });
  };

  // Shared Technical-AEO site-audit worker. Used by BOTH the manual
  // `POST /technical-aeo/runs` route and the scheduled `site-audit` kind. The
  // run row is created by the caller; this runs the sitemap crawl + audit and
  // hands off to the post-run coordinator on completion.
  const runSiteAudit = (
    runId: string,
    projectId: string,
    auditOpts?: { sitemapUrl?: string; limit?: number },
  ): void => {
    executeSiteAudit(opts.db, runId, projectId, auditOpts ?? {})
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch((err: unknown) => {
        app.log.error({ runId, err }, "Site audit failed");
      });
  };

  // OpenAI ads credential store — stores Ads Manager SDK keys in ~/.canonry/config.yaml
  const adsCredentialStore = {
    getConnection: (projectName: string) => {
      return getOpenAiAdsConnection(opts.config, projectName);
    },
    upsertConnection: (connection: {
      projectName: string;
      apiKey: string;
      adAccountId?: string | null;
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertOpenAiAdsConnection(opts.config, connection);
      saveConfigPatch(opts.config);
      return updated;
    },
    removeConnection: (projectName: string) => {
      const removed = removeOpenAiAdsConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  };

  // Validates an SDK key by reading its own ad account from the upstream API.
  const verifyAdsAccount = async (apiKey: string) => {
    const account = await getAdAccount(apiKey);
    return {
      id: account.id,
      name: account.name,
      status: account.status,
      currencyCode: account.currency_code ?? null,
      timezone: account.timezone ?? null,
    };
  };

  const scheduler = new Scheduler(opts.db, {
    onRunCreated: (runId, projectId, providers, location) => {
      jobRunner
        .executeRun(runId, projectId, providers, location)
        .catch((err: unknown) => {
          app.log.error({ runId, err }, "Scheduled job runner failed");
        });
    },
    onTrafficSyncRequested: (projectName, sourceId) => {
      // Reuse the same in-process API client Aero uses. The traffic-sync
      // endpoint owns run-row creation, dedupe, rollup writes, and emits
      // the `traffic.synced` telemetry — the scheduler only triggers it.
      aeroClient.trafficSync(projectName, sourceId).catch((err: unknown) => {
        app.log.error(
          {
            projectName,
            sourceId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Scheduled traffic sync failed",
        );
      });
    },
    onGbpSyncRequested: (runId, projectId) => {
      // The scheduler already created the gbp-sync run row; run the same
      // worker the manual route uses (selected-location sync).
      runGbpSync(runId, projectId);
    },
    onAdsSyncRequested: (runId, projectId) => {
      // The scheduler already created the ads-sync run row; run the worker.
      runAdsSync(runId, projectId);
    },
    onDataRefreshRequested: (projectName) => {
      // Fan out to every connected data integration (GSC, Bing, GA, GBP) via
      // the same in-process client. refreshAllIntegrations isolates each
      // integration's failure with Promise.allSettled and never rejects.
      void refreshAllIntegrations(aeroClient, projectName);
    },
    onBacklinksSyncRequested: (projectName) => {
      // Re-probe Common Crawl for the newest rolling window. The release sync is
      // workspace-GLOBAL, so we gate on freshness: skip when the latest published
      // release is already synced READY (avoids re-downloading a ~4 GB/~13 GB
      // near-identical window every tick). We match on (release, status) directly
      // rather than the most-recently-updated ready row, so re-syncing an older
      // release out of band doesn't make us re-trigger an already-synced latest.
      // Otherwise reuse POST /backlinks/syncs, which owns insert/dedupe (UNIQUE
      // release + non-terminal check) and the per-project auto-extract fan-out.
      // Probe directly (not the 5-min cache) so each tick sees fresh results.
      void (async () => {
        const probed = await probeLatestRelease().catch((err: unknown) => {
          app.log.warn(
            { projectName, err },
            "Scheduled backlinks sync: latest-release probe failed",
          );
          return null;
        });
        if (!probed) return;
        const alreadySynced = opts.db
          .select()
          .from(ccReleaseSyncsTable)
          .where(
            and(
              eq(ccReleaseSyncsTable.release, probed.release),
              eq(ccReleaseSyncsTable.status, CcReleaseSyncStatuses.ready),
            ),
          )
          .limit(1)
          .get();
        if (alreadySynced) {
          app.log.info(
            { projectName, release: probed.release },
            "Scheduled backlinks sync: already up to date, skipping",
          );
          return;
        }
        aeroClient
          .backlinksTriggerSync(probed.release)
          .catch((err: unknown) => {
            app.log.error(
              {
                projectName,
                release: probed.release,
                err: err instanceof Error ? err.message : String(err),
              },
              "Scheduled backlinks sync failed",
            );
          });
      })();

      // Bing inbound links are per-project and live (not release-gated), so pull
      // them independently of the workspace Common Crawl probe — but only when
      // the project actually has a Bing Webmaster connection, to keep CC-only
      // projects quiet. POST /backlinks/bing-sync owns the run + executor.
      const project = opts.db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.name, projectName))
        .get();
      if (
        project &&
        bingConnectionStore.getConnection(project.canonicalDomain)
      ) {
        aeroClient.backlinksBingSync(projectName).catch((err: unknown) => {
          app.log.error(
            {
              projectName,
              err: err instanceof Error ? err.message : String(err),
            },
            "Scheduled Bing backlinks sync failed",
          );
        });
      }
    },
    onSiteAuditRequested: (runId, projectId) => {
      // The scheduler already created the site-audit run row; run the same
      // worker the manual POST /technical-aeo/runs route uses (default limit).
      runSiteAudit(runId, projectId);
    },
  });

  // Build provider summary for API routes (dynamic from adapter list)
  const providerSummary = API_ADAPTERS.map((adapter) => ({
    name: adapter.name,
    displayName: adapter.displayName,
    keyUrl: adapter.keyUrl,
    modelHint: `e.g. ${adapter.modelRegistry.defaultModel}`,
    model: registry.get(adapter.name)?.config.model,
    defaultModel: adapter.modelRegistry.defaultModel,
    configured: !!registry.get(adapter.name),
    quota: registry.get(adapter.name)?.config.quotaPolicy,
    vertexConfigured:
      adapter.name === "gemini"
        ? !!opts.config.providers?.gemini?.vertexProject
        : undefined,
  }));
  const googleSettingsSummary = {
    configured: Boolean(
      opts.config.google?.clientId && opts.config.google?.clientSecret,
    ),
  };
  const bingSettingsSummary = {
    // Treat Bing as configured if there is at least one connection with an API key,
    // OR if a global bing.apiKey is set. The CLI stores keys per-connection
    // (bing.connections[].apiKey), so checking only bing.apiKey missed existing connections.
    configured: Boolean(
      opts.config.bing?.apiKey ||
      opts.config.bing?.connections?.some((c) => c.apiKey),
    ),
  };

  // Bing connection store — stores connections in ~/.canonry/config.yaml
  const bingConnectionStore = {
    getConnection: (domain: string) => {
      return opts.config.bing?.connections?.find((c) => c.domain === domain);
    },
    upsertConnection: (connection: {
      domain: string;
      apiKey: string;
      siteUrl?: string | null;
      createdByProjectId?: string | null;
      createdAt: string;
      updatedAt: string;
    }) => {
      if (!opts.config.bing) opts.config.bing = {};
      if (!opts.config.bing.connections) opts.config.bing.connections = [];
      const idx = opts.config.bing.connections.findIndex(
        (c) => c.domain === connection.domain,
      );
      const normalized = {
        ...connection,
        createdByProjectId: connection.createdByProjectId ?? null,
      };
      if (idx >= 0) {
        opts.config.bing.connections[idx] = normalized;
      } else {
        opts.config.bing.connections.push(normalized);
      }
      saveConfigPatch(opts.config);
      return normalized;
    },
    updateConnection: (
      domain: string,
      patch: Partial<{
        apiKey: string;
        siteUrl: string | null;
        updatedAt: string;
      }>,
    ) => {
      const conn = opts.config.bing?.connections?.find(
        (c) => c.domain === domain,
      );
      if (!conn) return undefined;
      Object.assign(conn, patch);
      saveConfigPatch(opts.config);
      return conn;
    },
    deleteConnection: (domain: string) => {
      if (!opts.config.bing?.connections) return false;
      const idx = opts.config.bing.connections.findIndex(
        (c) => c.domain === domain,
      );
      if (idx < 0) return false;
      opts.config.bing.connections.splice(idx, 1);
      saveConfigPatch(opts.config);
      return true;
    },
  } as const;

  // GA4 credential store — stores service account keys in ~/.canonry/config.yaml
  const ga4CredentialStore = {
    getConnection: (projectName: string) => {
      return getGa4Connection(opts.config, projectName);
    },
    upsertConnection: (connection: {
      projectName: string;
      propertyId: string;
      clientEmail: string;
      privateKey: string;
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertGa4Connection(opts.config, connection);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeGa4Connection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  // Cloud Run credential store — stores SA keys / OAuth tokens in ~/.canonry/config.yaml
  const cloudRunCredentialStore = {
    getConnection: (projectName: string) => {
      return getCloudRunConnection(opts.config, projectName);
    },
    upsertConnection: (record: {
      projectName: string;
      gcpProjectId: string;
      serviceName?: string;
      location?: string;
      authMode: "oauth" | "service-account";
      clientEmail?: string;
      privateKey?: string;
      refreshToken?: string;
      tokenExpiresAt?: string;
      scopes?: string[];
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertCloudRunConnection(opts.config, record);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeCloudRunConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  // WordPress traffic-logger credential store — stores Application Passwords
  // in ~/.canonry/config.yaml under `wordpressTraffic.connections`.
  const wordpressTrafficCredentialStore = {
    getConnection: (projectName: string) => {
      return getWordpressTrafficConnection(opts.config, projectName);
    },
    upsertConnection: (record: {
      projectName: string;
      baseUrl: string;
      username: string;
      applicationPassword: string;
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertWordpressTrafficConnection(opts.config, record);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeWordpressTrafficConnection(
        opts.config,
        projectName,
      );
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  // Vercel traffic credential store — stores Vercel API tokens in
  // ~/.canonry/config.yaml under `vercelTraffic.connections`.
  const vercelTrafficCredentialStore = {
    getConnection: (projectName: string) => {
      return getVercelTrafficConnection(opts.config, projectName);
    },
    upsertConnection: (record: {
      projectName: string;
      projectId: string;
      teamId: string;
      token: string;
      environment: "production" | "preview";
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertVercelTrafficConnection(opts.config, record);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeVercelTrafficConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  // Cloudflare Worker traffic credential store — stores per-source bearer
  // tokens and HMAC secrets in ~/.canonry/config.yaml under
  // `cloudflareTraffic.connections`. The DB only carries the sha256 of the
  // bearer; cleartext secrets never touch the database.
  const cloudflareTrafficCredentialStore = {
    getConnection: (projectName: string) => {
      return getCloudflareTrafficConnection(opts.config, projectName);
    },
    getConnectionBySourceId: (sourceId: string) => {
      return getCloudflareTrafficConnectionBySourceId(opts.config, sourceId);
    },
    upsertConnection: (record: {
      projectName: string;
      sourceId: string;
      bearerToken: string;
      hmacSecret: string;
      workerVersion: string;
      expectedBotListVersion: string;
      zoneId: string | null;
      accountId: string | null;
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertCloudflareTrafficConnection(opts.config, record);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeCloudflareTrafficConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  const googleStateSecret =
    process.env.GOOGLE_STATE_SECRET ?? crypto.randomBytes(32).toString("hex");

  const googleConnectionStore = {
    listConnections: (domain: string) =>
      listGoogleConnections(opts.config, domain),
    getConnection: (domain: string, connectionType: "gsc" | "ga4" | "gbp") =>
      getGoogleConnection(opts.config, domain, connectionType),
    upsertConnection: (connection: {
      domain: string;
      connectionType: "gsc" | "ga4" | "gbp";
      propertyId?: string | null;
      sitemapUrl?: string | null;
      accessToken?: string;
      refreshToken?: string | null;
      tokenExpiresAt?: string | null;
      scopes?: string[];
      createdByProjectId?: string | null;
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertGoogleConnection(opts.config, connection);
      saveConfigPatch(opts.config);
      return updated;
    },
    updateConnection: (
      domain: string,
      connectionType: "gsc" | "ga4" | "gbp",
      patch: Partial<{
        propertyId?: string | null;
        sitemapUrl?: string | null;
        accessToken?: string;
        refreshToken?: string | null;
        tokenExpiresAt?: string | null;
        scopes?: string[];
        updatedAt: string;
      }>,
    ) => {
      const updated = patchGoogleConnection(
        opts.config,
        domain,
        connectionType,
        patch,
      );
      if (updated) saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (
      domain: string,
      connectionType: "gsc" | "ga4" | "gbp",
    ) => {
      const removed = removeGoogleConnection(
        opts.config,
        domain,
        connectionType,
      );
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  const wordpressConnectionStore = {
    getConnection: (projectName: string) => {
      return getWordpressConnection(opts.config, projectName);
    },
    upsertConnection: (connection: {
      projectName: string;
      url: string;
      stagingUrl?: string;
      username: string;
      appPassword: string;
      defaultEnv: "live" | "staging";
      createdAt: string;
      updatedAt: string;
    }) => {
      const updated = upsertWordpressConnection(opts.config, connection);
      saveConfigPatch(opts.config);
      return updated;
    },
    updateConnection: (
      projectName: string,
      patch: Partial<{
        url: string;
        stagingUrl?: string;
        username: string;
        appPassword: string;
        defaultEnv: "live" | "staging";
        updatedAt: string;
      }>,
    ) => {
      const updated = patchWordpressConnection(opts.config, projectName, patch);
      if (updated) saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeWordpressConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
  } as const;

  // Resolve base path early so API route prefix and SPA handler both use it.
  // Normalize: ensure it starts and ends with '/' (e.g. '/canonry/').
  // A value that normalises to bare '/' is treated as no base path to avoid
  // a duplicate-route error with fastify-static (which also registers '/').
  const rawBasePath = process.env.CANONRY_BASE_PATH ?? opts.config.basePath;
  const normalizedBasePath = rawBasePath
    ? "/" + rawBasePath.replace(/^\//, "").replace(/\/?$/, "/")
    : undefined;
  const basePath: string | undefined =
    normalizedBasePath === "/" ? undefined : normalizedBasePath;

  // Read-only embed mode (#716). Resolve once at boot (env over config.yaml).
  // When disabled, the injected SPA config stays byte-for-byte unchanged and no
  // framing header is emitted. When enabled, every SPA document gets a
  // fail-closed `Content-Security-Policy: frame-ancestors` header.
  const embed = resolveEmbedConfig(process.env, opts.config);
  const embedCsp = embed.enabled
    ? frameAncestorsHeaderValue(embed.allowedOrigins)
    : undefined;

  // Register API routes.
  // When a basePath is set, routes are registered at `${basePath}api/v1` so they
  // match requests forwarded by a reverse proxy that does NOT strip the prefix
  // (e.g. Caddy `reverse_proxy localhost:4100` without `uri strip_prefix`).
  // If the proxy does strip the prefix, set CANONRY_BASE_PATH to empty/unset and
  // let the proxy handle path rewriting instead.
  const apiPrefix = basePath ? `${basePath}api/v1` : "/api/v1";
  // Ensure the configured API key exists in the DB — handles upgrades from
  // older versions that stored the key in config.yaml but never inserted it
  // into the api_keys table (or used a different DB file).
  if (opts.config.apiKey) {
    const keyHash = hashApiKey(opts.config.apiKey);
    const existing = opts.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .get();
    if (!existing) {
      const prefix = opts.config.apiKey.slice(0, 12);
      opts.db
        .insert(apiKeys)
        .values({
          id: `key_${crypto.randomBytes(8).toString("hex")}`,
          name: "default",
          keyHash,
          keyPrefix: prefix,
          scopes: ["*"],
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  }

  const sessionCookiePath = basePath ?? "/";
  const sessionCookieSecure = Boolean(
    opts.config.publicUrl?.startsWith("https://") ||
    opts.config.apiUrl?.startsWith("https://"),
  );
  const sessions = new Map<string, SessionRecord>();

  const pruneExpiredSessions = () => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      if (session.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }
  };

  const createSession = (apiKeyId: string) => {
    pruneExpiredSessions();
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, {
      apiKeyId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return sessionId;
  };

  const resolveSessionApiKeyId = (sessionId: string) => {
    pruneExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    return session.apiKeyId;
  };

  const clearSession = (sessionId: string | undefined) => {
    if (sessionId) {
      sessions.delete(sessionId);
    }
  };

  // Resolve the default API key record once — used by password-based sessions
  // to bind the session to the server's configured key.
  const getDefaultApiKey = () => {
    if (!opts.config.apiKey) return undefined;
    return opts.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(opts.config.apiKey)))
      .get();
  };

  const createPasswordSession = (reply: FastifyReply) => {
    const key = getDefaultApiKey();
    if (!key || key.revokedAt) return false;

    const sessionId = createSession(key.id);
    reply.header(
      "set-cookie",
      serializeSessionCookie({
        name: SESSION_COOKIE_NAME,
        value: sessionId,
        path: sessionCookiePath,
        secure: sessionCookieSecure,
        ttlMs: SESSION_TTL_MS,
      }),
    );
    return true;
  };

  // Whether the server is bound to a loopback interface. On loopback only
  // local processes can connect, so the first-run password bootstrap is safe
  // to leave unauthenticated. On a non-loopback bind the server is reachable
  // off-box and the bootstrap must be gated (see `/session/setup`).
  const boundToLoopback = isLoopbackBindHost(opts.host);

  // Resolve a non-revoked API key from a `Bearer cnry_…` header, if present.
  // Used to gate the first-run password setup on an exposed server — the
  // `/session/setup` route is in the auth skip-list, so it must do its own
  // bearer check rather than rely on `request.apiKey`.
  const requestHasValidApiKey = (request: FastifyRequest): boolean => {
    const header = request.headers.authorization;
    if (!header) return false;
    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return false;
    const key = opts.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(parts[1]!)))
      .get();
    return Boolean(key && !key.revokedAt);
  };

  app.get(apiPrefix + "/session", async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
    return reply.send({
      authenticated: Boolean(sessionId && resolveSessionApiKeyId(sessionId)),
      setupRequired: !opts.config.dashboardPasswordHash,
    });
  });

  // One-time password setup — only works when no password is configured yet.
  app.post<{
    Body: { password?: string };
  }>(apiPrefix + "/session/setup", async (request, reply) => {
    // First-run dashboard password setup mints a session bound to the install's
    // default `*` API key — full read/write on every project. That is safe on a
    // loopback bind (only local processes can reach it) but a pre-auth privilege
    // escalation on a network-reachable server, where any unauthenticated
    // first-visitor could claim it. When bound off-box, require the bearer key.
    if (!boundToLoopback && !requestHasValidApiKey(request)) {
      const err = authRequired(
        "This server is network-reachable; setting the dashboard password requires a valid API key.",
      );
      return reply.status(err.statusCode).send(err.toJSON());
    }

    if (opts.config.dashboardPasswordHash) {
      const err = validationError("Dashboard password is already configured");
      return reply.status(err.statusCode).send(err.toJSON());
    }

    const password = request.body?.password?.trim();
    if (!password || password.length < 8) {
      const err = validationError("Password must be at least 8 characters");
      return reply.status(err.statusCode).send(err.toJSON());
    }

    opts.config.dashboardPasswordHash = hashDashboardPassword(password);
    saveConfigPatch(opts.config);

    if (!createPasswordSession(reply)) {
      const err = authInvalid();
      return reply.status(err.statusCode).send(err.toJSON());
    }
    return reply.send({ authenticated: true });
  });

  // Login with dashboard password or API key.
  app.post<{
    Body: { password?: string; apiKey?: string };
  }>(apiPrefix + "/session", async (request, reply) => {
    const password = request.body?.password?.trim();
    const apiKey = request.body?.apiKey?.trim();

    if (password) {
      if (!opts.config.dashboardPasswordHash) {
        const err = validationError(
          "No dashboard password configured — use /session/setup first",
        );
        return reply.status(err.statusCode).send(err.toJSON());
      }
      const verification = verifyDashboardPassword(
        password,
        opts.config.dashboardPasswordHash,
      );
      if (!verification.ok) {
        return reply.status(401).send({
          error: { code: "AUTH_INVALID", message: "Incorrect password" },
        });
      }
      // Transparent migration: a successful login against the legacy
      // unsalted SHA-256 hash rewrites the config with a fresh scrypt hash
      // so the next login no longer needs the legacy fallback path.
      if (verification.needsRehash) {
        opts.config.dashboardPasswordHash = hashDashboardPassword(password);
        saveConfigPatch(opts.config);
      }
      if (!createPasswordSession(reply)) {
        return reply.status(401).send({
          error: {
            code: "AUTH_INVALID",
            message: "Server API key not found — re-run canonry init",
          },
        });
      }
      return reply.send({ authenticated: true });
    }

    if (apiKey) {
      const key = opts.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashApiKey(apiKey)))
        .get();

      if (!key || key.revokedAt) {
        const err = authInvalid();
        return reply.status(err.statusCode).send(err.toJSON());
      }

      opts.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
        .run();

      const sessionId = createSession(key.id);
      reply.header(
        "set-cookie",
        serializeSessionCookie({
          name: SESSION_COOKIE_NAME,
          value: sessionId,
          path: sessionCookiePath,
          secure: sessionCookieSecure,
          ttlMs: SESSION_TTL_MS,
        }),
      );
      return reply.send({ authenticated: true });
    }

    const err = validationError("Either password or apiKey is required");
    return reply.status(err.statusCode).send(err.toJSON());
  });

  app.delete(apiPrefix + "/session", async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
    clearSession(sessionId);
    reply.header(
      "set-cookie",
      serializeSessionCookie({
        name: SESSION_COOKIE_NAME,
        value: null,
        path: sessionCookiePath,
        secure: sessionCookieSecure,
        ttlMs: SESSION_TTL_MS,
      }),
    );
    return reply.status(204).send();
  });

  const LATEST_RELEASE_TTL_MS = 5 * 60 * 1000;
  let latestReleaseCache: {
    value: import("@ainyc/canonry-contracts").CcAvailableRelease | null;
    expiresAt: number;
  } | null = null;
  const discoverLatestRelease = async (): Promise<
    import("@ainyc/canonry-contracts").CcAvailableRelease | null
  > => {
    const now = Date.now();
    if (latestReleaseCache && latestReleaseCache.expiresAt > now) {
      return latestReleaseCache.value;
    }
    const probed = await probeLatestRelease().catch((err: unknown) => {
      app.log.warn({ err }, "Common Crawl latest-release probe failed");
      return null;
    });
    const value = probed
      ? {
          release: probed.release,
          vertexUrl: probed.vertexUrl,
          edgesUrl: probed.edgesUrl,
          vertexBytes: probed.vertexBytes,
          edgesBytes: probed.edgesBytes,
          lastModified: probed.lastModified,
        }
      : null;
    latestReleaseCache = { value, expiresAt: now + LATEST_RELEASE_TTL_MS };
    return value;
  };

  // LLM-backed "Why this?" explainer for content recommendations. Injected
  // into api-routes so the package stays LLM-agnostic — canonry owns the
  // pi-ai + capability-tier wiring. Falls back to a clean 503 when no
  // provider is configured (handled inside the explainer factory).
  const explainContentRecommendation = createRecommendationExplainer({
    config: opts.config,
  });
  // LLM-backed structured BRIEF synthesizer (brief mode). Same plumbing as the
  // explainer; gated to ownable targets by the route. 503 when no provider.
  const briefContentRecommendation = createRecommendationBriefSynthesizer({
    config: opts.config,
  });

  await app.register(apiRoutes, {
    db: opts.db,
    routePrefix: apiPrefix,
    skipAuth: false,
    sessionCookieName: SESSION_COOKIE_NAME,
    resolveSessionApiKeyId,
    explainContentRecommendation,
    briefContentRecommendation,
    briefPromptVersion: RECOMMENDATION_BRIEF_PROMPT_VERSION,
    // On-disk paths the daemon depends on. The api-routes plugin uses these
    // to fail loud (HTTP 503) when the operator wipes the DB or config out
    // from under a running serve — SQLite holds the inode open across
    // `unlink`, so without this the daemon keeps serving stale data from
    // an orphaned file and `rm ~/.canonry/data.db` silently does nothing.
    //
    // Only attach `configPath` if it actually exists at construction time:
    // production always boots via `serveCommand`, which calls `loadConfig()`
    // and would have thrown if the file were missing; tests that construct
    // `createServer` directly (bypassing `loadConfig`) won't have written
    // a config and shouldn't get 503s from a stub-missing file.
    runtimeStatePaths: (() => {
      const configPath = getConfigPath();
      return {
        databasePath: opts.config.database,
        configPath: fs.existsSync(configPath) ? configPath : null,
      };
    })(),
    // Snapshot the bundled skill trees (version + file hashes) so the
    // `agent.skills.current` doctor check can flag a `~/.claude/skills/` install
    // that has drifted behind this build. Best-effort: if the bundled assets
    // can't be resolved the check simply skips rather than failing boot.
    bundledSkills: (() => {
      try {
        return getBundledSkillSnapshots();
      } catch {
        return undefined;
      }
    })(),
    // Local canonry serve runs on the operator's machine, where pointing a
    // webhook at localhost (Discord test container, Pipedream-mock dev server,
    // etc.) is a legitimate workflow. Default to allowing it for the local
    // installer; cloud deployments inherit the secure default of `false` by
    // not passing this option. Override with CANONRY_ALLOW_LOOPBACK_WEBHOOKS=0.
    allowLoopbackWebhooks: process.env.CANONRY_ALLOW_LOOPBACK_WEBHOOKS !== "0",
    // Local-only Aero agent routes. Registered here so they inherit api-routes'
    // auth plugin — bare `registerAgentRoutes(app, ...)` would skip auth.
    registerAuthenticatedRoutes: async (scope) => {
      // Aero kill-switch: don't serve the interactive agent routes when disabled.
      if (!sessionRegistry) return;
      registerAgentRoutes(scope, { db: opts.db, sessionRegistry });
    },
    getGoogleAuthConfig: () => getGoogleAuthConfig(opts.config),
    getPlacesConfig: () => getPlacesConfig(opts.config),
    // Resolved fresh each call so a key added at runtime (settings API) shows
    // up immediately in the `config.agent-providers` doctor check.
    getAgentProviderSummary: () =>
      buildAgentProvidersResponse(opts.config).providers,
    googleConnectionStore,
    googleStateSecret,
    publicUrl: opts.config.publicUrl,
    onGscSyncRequested: (
      runId: string,
      projectId: string,
      syncOpts?: { days?: number; full?: boolean },
    ) => {
      const { clientId: googleClientId, clientSecret: googleClientSecret } =
        getGoogleAuthConfig(opts.config);
      if (!googleClientId || !googleClientSecret) {
        app.log.error(
          "GSC sync requested but Google OAuth credentials are not configured in the local config",
        );
        return;
      }
      executeGscSync(opts.db, runId, projectId, {
        ...syncOpts,
        config: opts.config,
      })
        // executeGscSync resolves only when the sync completed, so a full
        // sitemap-coverage refresh chains directly off success. `gsc-sync`
        // alone only inspects the top 50 pages by clicks, leaving newly-added
        // URLs out of the coverage dashboard until the next manual inspection.
        .then(() => maybeRefreshGscCoverage(opts.db, opts.config, projectId))
        .catch((err: unknown) => {
          app.log.error({ runId, err }, "GSC sync failed");
        });
    },
    onInspectSitemapRequested: (
      runId: string,
      projectId: string,
      inspectOpts?: { sitemapUrl?: string },
    ) => {
      const { clientId: googleClientId, clientSecret: googleClientSecret } =
        getGoogleAuthConfig(opts.config);
      if (!googleClientId || !googleClientSecret) {
        app.log.error(
          "Inspect sitemap requested but Google OAuth credentials are not configured",
        );
        return;
      }
      executeInspectSitemap(opts.db, runId, projectId, {
        ...inspectOpts,
        config: opts.config,
      }).catch((err: unknown) => {
        app.log.error({ runId, err }, "Inspect sitemap failed");
      });
    },
    onGbpSyncRequested: (
      runId: string,
      projectId: string,
      syncOpts?: {
        locationNames?: string[];
        daysOfMetrics?: number;
        monthsOfKeywords?: number;
      },
    ) => {
      runGbpSync(runId, projectId, syncOpts);
    },
    adsCredentialStore,
    verifyAdsAccount,
    onAdsSyncRequested: (runId: string, projectId: string) => {
      runAdsSync(runId, projectId);
    },
    getBacklinksStatus: () => ({
      duckdbInstalled: isDuckdbInstalled(),
      duckdbVersion: readInstalledVersion() ?? undefined,
      duckdbSpec: DUCKDB_SPEC,
      pluginDir: PLUGIN_DIR,
    }),
    onInstallBacklinks: async () => {
      const result = await installDuckdb({
        onLog: (line) => app.log.info({ line }, "duckdb install"),
      });
      return {
        installed: true,
        version: result.version,
        path: result.path,
        alreadyPresent: result.alreadyPresent,
      };
    },
    onReleaseSyncRequested: (syncId: string, release: string) => {
      executeReleaseSync(opts.db, syncId, {
        release,
        deps: {
          enqueueAutoExtract: ({ projectId, release: r }) => {
            const now = new Date().toISOString();
            const runId = crypto.randomUUID();
            opts.db
              .insert(runs)
              .values({
                id: runId,
                projectId,
                kind: RunKinds["backlink-extract"],
                status: RunStatuses.queued,
                trigger: RunTriggers.scheduled,
                createdAt: now,
              })
              .run();
            executeBacklinkExtract(opts.db, runId, projectId, {
              release: r,
            }).catch((err: unknown) => {
              app.log.error(
                { runId, projectId, err },
                "Auto backlink extract failed",
              );
            });
          },
        },
      }).catch((err: unknown) => {
        app.log.error({ syncId, err }, "Common Crawl release sync failed");
      });
    },
    onBacklinkExtractRequested: (
      runId: string,
      projectId: string,
      release?: string,
    ) => {
      executeBacklinkExtract(opts.db, runId, projectId, { release }).catch(
        (err: unknown) => {
          app.log.error({ runId, err }, "Backlink extract failed");
        },
      );
    },
    onBingBacklinkSyncRequested: (runId: string, projectId: string) => {
      executeBingBacklinkSync(opts.db, runId, projectId, {
        resolveConnection: (domain) =>
          bingConnectionStore.getConnection(domain),
      }).catch((err: unknown) => {
        app.log.error({ runId, err }, "Bing backlink sync failed");
      });
    },
    onDiscoveryRunRequested: (input) => {
      // Run discovery in the background; the handler captures and persists
      // its own errors, so we only need to log a top-level failure if the
      // handler itself threw before reaching that recovery path.
      executeDiscoveryRun({
        db: opts.db,
        registry,
        runId: input.runId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        icpDescription: input.icpDescription,
        dedupThreshold: input.dedupThreshold,
        maxProbes: input.maxProbes,
        locations: input.locations,
      })
        .then(() => runCoordinator.onRunCompleted(input.runId, input.projectId))
        .catch((err: unknown) => {
          app.log.error({ runId: input.runId, err }, "Discovery run failed");
        });
    },
    // Read issued search queries (fan-out) back out of a stored probe payload.
    // Discovery is Gemini-only today, so the Gemini extractor handles every
    // probe; the provider arg lets a future multi-provider discovery dispatch.
    harvestSearchQueries: ({ rawResponse }) =>
      extractSearchQueriesFromRaw(rawResponse),
    // Embed seam for the harvest's semantic novelty pass — the same Gemini
    // embedder the discovery seed pipeline uses. Resolved at call time so a
    // provider key set after boot is picked up; rejects (→ route degrades to
    // exact-match novelty) when no Gemini key is configured.
    embedQueries: (queriesToEmbed) => {
      const cfg = registry.get("gemini")?.config;
      if (!cfg?.apiKey) {
        return Promise.reject(
          new Error(
            "Gemini API key not configured; harvest semantic novelty unavailable",
          ),
        );
      }
      return embedGeminiQueries(queriesToEmbed, {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
      });
    },
    onSiteAuditRequested: (
      runId: string,
      projectId: string,
      auditOpts?: { sitemapUrl?: string; limit?: number },
    ) => {
      // The route already created the site-audit run row; run the shared worker.
      runSiteAudit(runId, projectId, auditOpts);
    },
    onBacklinksPruneCache: (release: string) => {
      try {
        pruneCachedRelease(release);
      } catch (err) {
        app.log.error({ release, err }, "Failed to prune cached release");
      }
    },
    listCachedReleases: () => {
      const cached = listCachedReleasesFromDisk();
      const syncByRelease = new Map<
        string,
        { status: string; updatedAt: string }
      >();
      for (const row of opts.db.select().from(ccReleaseSyncsTable).all()) {
        syncByRelease.set(row.release, {
          status: row.status,
          updatedAt: row.updatedAt,
        });
      }
      return cached.map((entry) => {
        const sync = syncByRelease.get(entry.release);
        return {
          release: entry.release,
          syncStatus: (sync?.status ??
            null) as import("@ainyc/canonry-contracts").CcCachedRelease["syncStatus"],
          bytes: entry.bytes,
          lastUsedAt: entry.lastUsedAt,
        };
      });
    },
    discoverLatestRelease,
    openApiInfo: {
      title: "Canonry API",
      version: PKG_VERSION,
      includeCanonryLocal: true,
    },
    providerSummary,
    providerAdapters: [...API_ADAPTERS, ...BROWSER_ADAPTERS].map((a) => ({
      name: a.name,
      displayName: a.displayName,
      mode: a.mode,
      modelValidationPattern: a.modelRegistry.validationPattern,
      modelValidationHint: a.modelRegistry.validationHint,
    })),
    googleSettingsSummary,
    bingSettingsSummary,
    bingConnectionStore,
    onBingInspectSitemapRequested: (
      runId: string,
      projectId: string,
      inspectOpts?: { sitemapUrl?: string },
    ) => {
      executeBingInspectSitemap(opts.db, runId, projectId, {
        ...inspectOpts,
        config: opts.config,
      })
        .then(() => {
          // Unlike executeGscSync, the Bing executor resolves even when the run
          // ends `failed` (every URL errored), so gate the cross-engine GSC
          // coverage refresh on the run actually completing. maybeRefreshGscCoverage
          // no-ops when GSC isn't connected, so Bing-only projects are unaffected.
          const finished = opts.db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId))
            .get();
          if (
            finished?.status === RunStatuses.completed ||
            finished?.status === RunStatuses.partial
          ) {
            return maybeRefreshGscCoverage(opts.db, opts.config, projectId);
          }
          return null;
        })
        .catch((err: unknown) => {
          app.log.error({ runId, err }, "Bing inspect sitemap failed");
        });
    },
    wordpressConnectionStore,
    ga4CredentialStore,
    cloudRunCredentialStore,
    wordpressTrafficCredentialStore,
    vercelTrafficCredentialStore,
    cloudflareTrafficCredentialStore,
    cloudflareTrafficIngestUrl: buildCloudflareIngestUrlTemplate(opts.config),
    onTrafficSynced: (event) => {
      // Emit anonymous canonry telemetry for every sync (success + fail).
      // Same envelope shape as run.completed (top-level `errorCode` on
      // failure, payload in `properties`). Counts are aggregate, sourceId
      // is an opaque UUID — no PII surface.
      trackEvent(
        "traffic.synced",
        {
          status: event.status,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          pulledEvents: event.pulledEvents,
          selfTrafficExcluded: event.selfTrafficExcluded,
          crawlerHits: event.crawlerHits,
          aiReferralHits: event.aiReferralHits,
          durationMs: event.durationMs,
        },
        event.errorCode ? { errorCode: event.errorCode } : undefined,
      );
    },
    onRunCreated: (
      runId: string,
      projectId: string,
      providers?: string[],
      location?: import("@ainyc/canonry-contracts").LocationContext | null,
    ) => {
      // Fire and forget — run executes in background
      jobRunner
        .executeRun(runId, projectId, providers, location)
        .catch((err: unknown) => {
          app.log.error({ runId, err }, "Job runner failed");
        });
    },
    onProviderUpdate: (
      providerName: string,
      apiKey: string,
      model?: string,
      baseUrl?: string,
      incomingQuota?: Partial<
        import("@ainyc/canonry-contracts").ProviderQuotaPolicy
      >,
    ) => {
      const name = providerName;
      if (!adapterMap[name]) return null;

      // Update config and persist
      if (!opts.config.providers) opts.config.providers = {};
      const existing = opts.config.providers[name];
      const beforeConfig = summarizeProviderConfig(existing);
      const mergedQuota = incomingQuota
        ? { ...(existing?.quota ?? DEFAULT_QUOTA), ...incomingQuota }
        : existing?.quota;
      opts.config.providers[name] = {
        apiKey: apiKey || existing?.apiKey,
        baseUrl: baseUrl || existing?.baseUrl,
        model: model || existing?.model,
        quota: mergedQuota,
        // Preserve Vertex AI config (Gemini provider) — these are set via
        // config file or env vars, not through the dashboard update payload
        vertexProject: existing?.vertexProject,
        vertexRegion: existing?.vertexRegion,
        vertexCredentials: existing?.vertexCredentials,
      };

      try {
        saveConfigPatch(opts.config);
      } catch (err) {
        app.log.error({ err }, "Failed to save config");
        return null;
      }

      // Re-register in the live registry (use preserved model if none was passed)
      const quota = opts.config.providers[name]!.quota ?? DEFAULT_QUOTA;
      registry.register(adapterMap[name]!, {
        provider: name,
        apiKey: apiKey || existing?.apiKey,
        baseUrl: baseUrl || existing?.baseUrl,
        model: model || existing?.model,
        quotaPolicy: quota,
        vertexProject: existing?.vertexProject,
        vertexRegion: existing?.vertexRegion,
        vertexCredentials: existing?.vertexCredentials,
      });

      // Update the providerSummary array in-place
      const entry = providerSummary.find((p) => p.name === name);
      if (entry) {
        entry.configured = true;
        entry.model = model || registry.get(name)?.config.model;
        entry.quota = quota;
        if (name === "gemini") {
          entry.vertexConfigured =
            !!opts.config.providers?.[name]?.vertexProject;
        }
      }

      const afterConfig = summarizeProviderConfig(opts.config.providers[name]);
      if (JSON.stringify(beforeConfig) !== JSON.stringify(afterConfig)) {
        const diff = JSON.stringify({
          before: existing ? beforeConfig : null,
          after: afterConfig,
        });
        const affectedProjectIds = opts.db
          .select({ id: projects.id, providers: projects.providers })
          .from(projects)
          .all()
          .filter((project) => {
            const configuredProviders = project.providers;
            return (
              configuredProviders.length === 0 ||
              configuredProviders.includes(name)
            );
          })
          .map((project) => project.id);
        const targetProjectIds =
          affectedProjectIds.length > 0 ? affectedProjectIds : [null];
        const createdAt = new Date().toISOString();

        opts.db
          .insert(auditLog)
          .values(
            targetProjectIds.map((projectId) => ({
              id: crypto.randomUUID(),
              projectId,
              actor: "api",
              action: existing ? "provider.updated" : "provider.created",
              entityType: "provider",
              entityId: name,
              diff,
              createdAt,
            })),
          )
          .run();
      }

      return {
        name,
        model: entry?.model,
        configured: true,
        quota,
      };
    },
    onGoogleSettingsUpdate: (clientId: string, clientSecret: string) => {
      try {
        setGoogleAuthConfig(opts.config, { clientId, clientSecret });
        saveConfigPatch(opts.config);
        googleSettingsSummary.configured = true;
        return { ...googleSettingsSummary };
      } catch (err) {
        app.log.error({ err }, "Failed to save Google OAuth config");
        return null;
      }
    },
    onBingSettingsUpdate: (apiKey: string) => {
      try {
        if (!opts.config.bing) opts.config.bing = {};
        opts.config.bing.apiKey = apiKey;
        saveConfigPatch(opts.config);
        bingSettingsSummary.configured = true;
        return { ...bingSettingsSummary };
      } catch (err) {
        app.log.error({ err }, "Failed to save Bing API key config");
        return null;
      }
    },
    onScheduleUpdated: (
      action: "upsert" | "delete",
      projectId: string,
      kind: import("@ainyc/canonry-contracts").SchedulableRunKind,
    ) => {
      if (action === "upsert") scheduler.upsert(projectId, kind);
      if (action === "delete") scheduler.remove(projectId, kind);
    },
    onProjectDeleted: (projectId: string) => {
      scheduler.removeAllForProject(projectId);
    },
    onAliasesChanged: (projectId: string, projectName: string) => {
      // Aliases feed `extractAnswerMentions` at run-time, but the resulting
      // boolean is frozen on `query_snapshots.answer_mentioned`. Rewrite
      // historical rows so the report + landscape dashboards line up with
      // the new alias set on next refresh. Deferred to setImmediate so the
      // PUT response goes out first; better-sqlite3 is sync so the actual
      // backfill blocks the event loop for the duration of the rebuild.
      setImmediate(() => {
        try {
          const result = backfillProjectAnswerMentions(opts.db, projectId);
          app.log.info(
            { projectId, projectName, ...result },
            "aliases changed — recomputed mention fields on historical snapshots",
          );
        } catch (err) {
          app.log.error(
            { err, projectId, projectName },
            "alias-triggered backfill failed",
          );
        }
      });
    },
    getTelemetryStatus: () => {
      const enabled = isTelemetryEnabled();
      return {
        enabled,
        // Only read/create the anonymous ID if telemetry is enabled.
        // Don't mutate config for opted-out users.
        anonymousId: enabled ? getOrCreateAnonymousId() : undefined,
      };
    },
    setTelemetryEnabled: (enabled: boolean) => {
      const config = loadConfig();
      config.telemetry = enabled;
      saveConfigPatch(config);
      // Keep in-memory config in sync
      opts.config.telemetry = enabled;
    },
    onCdpConfigure: async (host: string, port: number) => {
      if (!opts.config.cdp) opts.config.cdp = {};
      opts.config.cdp.host = host;
      opts.config.cdp.port = port;
      try {
        saveConfigPatch(opts.config);
      } catch (err) {
        app.log.error({ err }, "Failed to save CDP config");
        throw err;
      }
      // Re-register CDP adapter with the new endpoint
      const CDP_DEFAULT_QUOTA = {
        maxConcurrency: 1,
        maxRequestsPerMinute: 4,
        maxRequestsPerDay: 200,
      };
      registry.register(cdpChatgptAdapter, {
        provider: "cdp:chatgpt",
        cdpEndpoint: `ws://${host}:${port}`,
        quotaPolicy: opts.config.cdp.quota ?? CDP_DEFAULT_QUOTA,
      });
    },
    getCdpStatus: async () => {
      const conn = registry.get("cdp:chatgpt");
      if (!conn) {
        return {
          connected: false,
          endpoint: opts.config.cdp
            ? `ws://${opts.config.cdp.host ?? "localhost"}:${opts.config.cdp.port ?? 9222}`
            : "",
          targets: [],
        };
      }
      const health = await conn.adapter.healthcheck(conn.config);
      return {
        connected: health.ok,
        endpoint: conn.config.cdpEndpoint ?? "",
        browserVersion: health.message,
        targets: [],
      };
    },
    onCdpScreenshot: async (query: string, targets?: string[]) => {
      const conn = registry.get("cdp:chatgpt");
      if (!conn) throw new Error("CDP provider not configured");
      const result = await conn.adapter.executeTrackedQuery(
        { query, canonicalDomains: [], competitorDomains: [] },
        conn.config,
      );
      const raw = result.rawResponse as {
        answerText?: string;
        groundingSources?: { uri: string; title: string }[];
      };
      return [
        {
          target: targets?.[0] ?? "chatgpt",
          screenshotPath: result.screenshotPath ?? "",
          answerText: raw.answerText ?? "",
          citations: raw.groundingSources ?? [],
        },
      ];
    },
    onGenerateQueries: async (providerName, count, project) => {
      const provider = registry.get(providerName);
      if (!provider)
        throw new Error(`Provider "${providerName}" is not configured`);

      const siteText = await fetchSiteText(project.domain);

      const prompt = buildQueryGenerationPrompt({
        domain: project.domain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingQueries: project.existingQueries,
        siteText,
        count,
      });

      const raw = await provider.adapter.generateText(prompt, provider.config);
      return parseQueryResponse(raw, count);
    },
    onSnapshotRequested: async (input) => {
      return snapshotService.createReport(input);
    },
  });

  // Try to serve static SPA assets
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const assetsDir = opts.assetsDir ?? path.join(dirname, "..", "assets");
  if (fs.existsSync(assetsDir)) {
    const indexPath = path.join(assetsDir, "index.html");

    // basePath is already resolved above. Used here for SPA serving.
    const injectConfig = (html: string): string => {
      const clientConfig: Record<string, unknown> = {};
      if (basePath) clientConfig.basePath = basePath;
      // Embed block is appended LAST and only when enabled, so the default
      // (non-embed) serve emits byte-for-byte the same `{}` / `{basePath}`.
      if (embed.enabled) {
        const embedClient = buildEmbedClientConfig(embed);
        if (embedClient) clientConfig.embed = embedClient;
      }

      const configScript = `<script>window.__CANONRY_CONFIG__=${JSON.stringify(clientConfig)}</script>`;
      // Inject <base href> unconditionally so relative asset paths (`./assets/…`)
      // resolve against the mount point instead of the current URL. Without this,
      // deep-links like `/projects/ainyc` request `/projects/assets/…js`, hit the
      // SPA fallback, and receive HTML where the browser expects JS.
      const baseTag = `<base href="${basePath ?? "/"}">`;
      return html
        .replace("<head>", `<head>${baseTag}`)
        .replace("</head>", `${configScript}</head>`);
    };

    // Single chokepoint for every SPA HTML document (root + deep-link
    // fallback): identical Cache-Control, the fail-closed embed framing header
    // when embed is enabled, config injection, and content type. Routing both
    // send sites through here keeps the framing header from drifting onto only
    // one of them (a deep-linked embed is served by the notFound fallback, not
    // serveIndex, so a header on serveIndex alone would leave it framable).
    const sendSpaDocument = (reply: FastifyReply, html: string) => {
      reply.header("Cache-Control", "no-cache, must-revalidate");
      if (embedCsp) reply.header("Content-Security-Policy", embedCsp);
      return reply.type("text/html").send(injectConfig(html));
    };

    const fastifyStatic = await import("@fastify/static");
    await app.register(fastifyStatic.default, {
      root: assetsDir,
      prefix: basePath ?? "/",
      wildcard: true,
      // Don't serve index.html automatically — we handle it with config injection
      serve: true,
      index: false,
      // Hashed asset filenames (Vite emits `index-<hash>.js`,
      // `vendor-recharts-<hash>.js`, etc.) are content-addressed: the URL
      // changes whenever the file changes. Safe to cache aggressively —
      // 1 year + immutable tells the browser to never revalidate.
      // Without this, the browser hits the server for every JS chunk on
      // every page load, defeating most of the dashboard's first-paint
      // budget.
      setHeaders: (res: SetHeadersResponse, path: string) => {
        // index.html serving is handled separately below; this static
        // middleware doesn't actually serve it (index:false), but guard
        // anyway in case fastify-static falls back through here.
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });

    // Serve index.html with injected config for the root/base-path route.
    // Register both the trailing-slash form ('/canonry/') and the bare form
    // ('/canonry') so either URL shape hits the handler without a 404.
    //
    // `Cache-Control: no-cache, must-revalidate` is critical here: the
    // HTML references hashed JS bundles (`index-<hash>.js`), so when we
    // deploy a new build the bundle filename changes. If the browser
    // caches the OLD index.html, it keeps loading the OLD bundle
    // filename — which may not exist on the server anymore, or worse,
    // does exist but is now stale code. `no-cache` forces a revalidation
    // request on every page load (typically a fast 304 if unchanged).
    const serveIndex = (_request: FastifyRequest, reply: FastifyReply) => {
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, "utf-8");
        return sendSpaDocument(reply, html);
      }
      return reply.status(404).send({ error: "Dashboard not built" });
    };
    const rootRouteTrailing = basePath ?? "/";
    app.get(rootRouteTrailing, serveIndex);
    // Also register the no-trailing-slash variant when base path is set
    // (e.g. '/canonry' in addition to '/canonry/') to avoid a 404 on bare navigation.
    if (basePath) {
      const rootRouteBare = basePath.replace(/\/$/, "");
      if (rootRouteBare) app.get(rootRouteBare, serveIndex);
    }

    // SPA fallback: serve index.html for unmatched routes that belong to this app.
    // - With no base path: serve for any non-API path (existing behaviour).
    // - With base path: only serve for paths under basePath to avoid hijacking
    //   other apps co-hosted on the same origin outside the base path.
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split("?")[0]!;

      // Never serve HTML for API routes — return proper JSON 404.
      // Check both the bare /api/ prefix and the basePath-prefixed form so the
      // SPA catch-all never intercepts API calls regardless of proxy config.
      const isApiRoute =
        url.startsWith("/api/") ||
        (basePath !== undefined && url.startsWith(`${basePath}api/`));
      if (isApiRoute) {
        return reply
          .status(404)
          .send({ error: "Not found", path: request.url });
      }

      // When a base path is configured, only serve the SPA for paths under it.
      if (basePath && !url.startsWith(basePath)) {
        return reply
          .status(404)
          .send({ error: "Not found", path: request.url });
      }

      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, "utf-8");
        // Same no-cache + embed-framing policy as `serveIndex` — SPA deep
        // links hit this handler and must always pick up the latest index.html
        // that points at the current hashed bundles, and (in embed mode) carry
        // the frame-ancestors header so a deep-linked embed isn't framable by
        // any origin.
        return sendSpaDocument(reply, html);
      }
      return reply.status(404).send({ error: "Not found" });
    });
  }

  // Health endpoint — registered at both /health and <basePath>health when base path is set,
  // so load-balancer probes work regardless of whether the proxy strips the prefix.
  // `updateAvailable` is read from an in-memory TTL cache and is non-blocking:
  // the registry probe runs in the background (stale-while-revalidate), so
  // /health responds in microseconds and never exceeds k8s probe budgets.
  // Opt-out via CANONRY_DISABLE_UPDATE_CHECK=1, DO_NOT_TRACK=1, CI, or
  // updateCheck: false in config.
  const healthHandler = () => {
    const update = checkLatestVersionForServer();
    return {
      status: "ok",
      service: "canonry",
      version: PKG_VERSION,
      ...(basePath ? { basePath: basePath.replace(/\/$/, "") } : {}),
      ...(update ? { updateAvailable: update } : {}),
    };
  };
  app.get("/health", healthHandler);
  if (basePath) {
    app.get(`${basePath}health`, healthHandler);
  }

  // Warm the update-check cache on boot so the first /health response after a
  // restart already includes `updateAvailable` (assuming the npm round-trip
  // completes before the dashboard's first poll, which it almost always does).
  // Fire-and-forget — boot does not wait on this.
  checkLatestVersionForServer();

  // Start scheduler after setup
  scheduler.start();

  // Graceful shutdown
  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  return app;
}

function buildQueryGenerationPrompt(ctx: {
  domain: string;
  displayName?: string;
  country: string;
  language: string;
  existingQueries: string[];
  siteText: string;
  count: number;
}): string {
  const lines: string[] = [
    "You are an SEO and AEO (Answer Engine Optimization) expert. Given a website's content, generate search queries that potential users would type into AI answer engines (ChatGPT, Gemini, Claude) to find services, products, or information like what this site offers.",
    "",
    `Website: ${ctx.domain}`,
  ];
  if (ctx.displayName) lines.push(`Business: ${ctx.displayName}`);
  lines.push(`Country: ${ctx.country}`);
  lines.push(`Language: ${ctx.language}`);

  if (ctx.siteText) {
    lines.push(
      "",
      "--- Site Content ---",
      ctx.siteText,
      "--- End Site Content ---",
    );
  }

  if (ctx.existingQueries.length > 0) {
    lines.push(
      "",
      `Already tracking (do NOT duplicate): ${ctx.existingQueries.join(", ")}`,
    );
  }

  lines.push(
    "",
    `Generate exactly ${ctx.count} queries that:`,
    '- Are short and concise (2-5 words each, like "best dentist brooklyn" not "what is the best dentist office in the brooklyn area for families")',
    "- Are natural phrases people would type into AI answer engines",
    "- Cover different intents (informational, transactional, navigational)",
    `- Are relevant to the ${ctx.country} market in ${ctx.language}`,
    "- Reflect the actual services/products/content found on the site",
    "",
    "Return ONLY the queries, one per line, no numbering or bullets.",
  );

  return lines.join("\n");
}

function parseQueryResponse(raw: string, count: number): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const line of raw.split("\n")) {
    // Strip leading numbering, bullets, dashes
    let cleaned = line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, "").trim();
    // Remove surrounding quotes
    cleaned = cleaned.replace(/^["']|["']$/g, "").trim();

    if (!cleaned) continue;
    // Skip meta-text lines
    if (
      /^(?:here are|sure|certainly|of course|i['’]ve|these are|below are)/i.test(
        cleaned,
      )
    )
      continue;
    // Enforce max 8 words
    if (cleaned.split(/\s+/).length > 8) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);

    if (results.length >= count) break;
  }

  return results;
}
