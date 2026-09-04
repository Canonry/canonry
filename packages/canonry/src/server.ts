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
import { anyUsersExist, apiRoutes, resolveTrustProxy, resolveVercelSyncDeadlineMs } from "@ainyc/canonry-api-routes";
import {
  apiKeys,
  auditLog,
  googleAdsConnections,
  gtmConnections,
  projects,
  researchRuns,
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
  forbidden,
  notFound,
  validationError,
  embedClientConfigForRequest,
  serializeForInlineScript,
  frameAncestorsHeaderValue,
  CcReleaseSyncStatuses,
  RunKinds,
  SchedulableRunKinds,
  RunStatuses,
  RunTriggers,
  ResearchRunStatuses,
  adsAccountDtoSchema,
  adsGeoSearchResponseSchema,
  adsConversionPixelListResponseSchema,
  adsConversionEventSettingListResponseSchema,
  GoogleMarketingProviders,
  type AdsCampaignBiddingType,
  type AdsAdGroupBillingEventType,
  type ProviderAdapter,
  type AgentPluginState,
  describeError,
} from "@ainyc/canonry-contracts";
import type {
  CanonryConfig,
  CloudflareTrafficConnectionConfigEntry,
  ProviderConfigEntry,
} from "./config.js";
import { resolveEmbedConfig, SERVER_ENFORCED_EMBED_PROJECT_TABS, unsupportedEmbedProjectTabs } from "./embed.js";
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
  getGoogleAdsAuthConfig,
  getGoogleAdsConnection,
  removeGoogleAdsConnection,
  removeLegacyGoogleAdsConnections,
  removeOrphanedGoogleAdsConnections,
  setGoogleAdsAuthConfig,
  upsertGoogleAdsConnection,
} from "./google-ads-config.js";
import {
  getGtmAuthConfig,
  getGtmConnection,
  removeGtmConnection,
  removeLegacyGtmConnections,
  removeOrphanedGtmConnections,
  upsertGtmConnection,
} from "./gtm-config.js";
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
  removeCloudflareTrafficConnectionBySourceId,
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
import { maybeShowActivationNotice } from './activation-notice.js'
import { executeGscSync } from "./gsc-sync.js";
import { executeGbpSync } from "./gbp-sync.js";
import {
  executeAdsSync,
  liveAdsInsightHourRange,
  accountLocalDate,
  readInsightDays,
  CAMPAIGN_INSIGHT_FIELDS,
  AD_GROUP_INSIGHT_FIELDS,
  CAMPAIGN_IN_PROGRESS_INSIGHT_FIELDS,
  AD_GROUP_IN_PROGRESS_INSIGHT_FIELDS,
} from "./ads-sync.js";
import {
  getOpenAiAdsConnection,
  upsertOpenAiAdsConnection,
  removeOpenAiAdsConnection,
} from "./ads-config.js";
import {
  OpenAiAdsCreativeTypes,
  OpenAiAdsWriteStatuses,
  activateAd,
  activateAdGroup,
  activateCampaign,
  archiveAd,
  archiveAdGroup,
  archiveCampaign,
  createAd,
  createAdGroup,
  createCampaign,
  getAd,
  getAdAccount,
  listAds,
  listAdGroups,
  listCampaigns,
  listConversionEventSettings,
  listConversionPixels,
  getAdGroup,
  getAdGroupInsights,
  getCampaign,
  getCampaignInsights,
  searchGeoLocations,
  pauseAd,
  pauseAdGroup,
  pauseCampaign,
  updateAd,
  updateAdGroup,
  updateCampaign,
  uploadImageFromUrl,
  OPENAI_ADS_MAX_PAGES,
  type OpenAiAdsBiddingConfigRequest,
  type OpenAiAdsInsightRow,
  type OpenAiAdsInsightsOptions,
} from "@ainyc/canonry-integration-openai-ads";
import {
  exchangeCode as exchangeGoogleOAuthCode,
  getAuthUrl as getGoogleOAuthUrl,
} from "@ainyc/canonry-integration-google";
import { GOOGLE_ADS_OAUTH_SCOPE } from "@ainyc/canonry-integration-google-ads";
import { GTM_READONLY_SCOPE } from "@ainyc/canonry-integration-google-tag-manager";
import { executeInspectSitemap } from "./gsc-inspect-sitemap.js";
import { executeBingInspectSitemap } from "./bing-inspect-sitemap.js";
import { maybeRefreshGscCoverage, runWasUserInitiated } from "./coverage-refresh.js";
import { executeReleaseSync } from "./commoncrawl-sync.js";
import { executeBacklinkExtract } from "./backlink-extract.js";
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
} from "@ainyc/canonry-db";
import { ProviderRegistry } from "./provider-registry.js";
import { Scheduler, ensureDefaultHealthSchedule } from "./scheduler.js";
import { refreshAllIntegrations } from "./data-refresh.js";
import { Notifier } from "./notifier.js";
import { IntelligenceService } from "./intelligence-service.js";
import { RunCoordinator } from "./run-coordinator.js";
import { SessionRegistry } from "./agent/session-registry.js";
import { buildAgentProvidersResponse } from "./agent/providers.js";
import { registerMcpHttpRoutes, mcpTransportPaths } from "./mcp-http.js";
import { registerOAuthRoutes, registerOAuthAdminRoutes, createCredentialChecker, parseCookieHeader, resolveUserSession, createUserSession, serializeUserSessionCookie, USER_SESSION_COOKIE_NAME } from "@ainyc/canonry-api-routes";
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
import { executeResearchRun } from "./research-runner.js";
import { createGoogleMarketingRuntime } from "./google-marketing-runtime.js";
import {
  executeGoogleAdsMarketingSync,
  executeGtmMarketingSync,
} from "./google-marketing-sync.js";
import { assessConversionTrackingIntegrity } from "@ainyc/canonry-intelligence";

const log = createLogger("Server");

const runtimeStartupByServer = new WeakMap<FastifyInstance, Promise<void>>();

/**
 * Wait for the scheduler and queued-work recovery that begin only after a
 * successful network bind. Fastify intentionally ignores `onListen` errors,
 * so production startup must await this explicit result before reporting the
 * server as ready.
 */
export function waitForServerRuntimeStartup(app: FastifyInstance): Promise<void> {
  const startup = runtimeStartupByServer.get(app);
  return startup ?? Promise.reject(new Error("Server runtime startup was not registered"));
}

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

/**
 * The model each registered provider will actually answer with: whatever this
 * instance has it configured to, else the adapter's own default. A plan run
 * freezes this, so a default that moves under a project starts a new
 * measurement series instead of quietly changing what its rows mean.
 */
function effectiveProviderModels(registry: ProviderRegistry): Record<string, string> {
  const models: Record<string, string> = {};
  for (const provider of registry.getAll()) {
    const model = provider.config.model ?? provider.adapter.modelRegistry.defaultModel;
    if (model) models[provider.adapter.name] = model;
  }
  return models;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}

function resolveDashboardRequirePassword(env: NodeJS.ProcessEnv, config: CanonryConfig): boolean {
  return parseBooleanEnv(env.CANONRY_DASHBOARD_REQUIRE_PASSWORD)
    ?? config.dashboard?.requirePassword
    ?? true;
}

function resolveDashboardShowResourceLinks(env: NodeJS.ProcessEnv, config: CanonryConfig): boolean {
  return parseBooleanEnv(env.CANONRY_DASHBOARD_SHOW_RESOURCE_LINKS)
    ?? config.dashboard?.showResourceLinks
    ?? true;
}

function resolveDashboardShowUpdateNotification(env: NodeJS.ProcessEnv, config: CanonryConfig): boolean {
  return parseBooleanEnv(env.CANONRY_DASHBOARD_SHOW_UPDATE_NOTIFICATION)
    ?? config.dashboard?.showUpdateNotification
    ?? true;
}

type DashboardOnboardingMode = NonNullable<NonNullable<CanonryConfig['dashboard']>['onboardingMode']>;

function parseDashboardOnboardingMode(value: string | undefined): DashboardOnboardingMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'legacy' || normalized === 'platform' || normalized === 'auto'
    ? normalized
    : undefined;
}

function resolveDashboardOnboardingMode(
  env: NodeJS.ProcessEnv,
  config: CanonryConfig,
): DashboardOnboardingMode | undefined {
  return parseDashboardOnboardingMode(env.CANONRY_ONBOARDING_MODE)
    ?? config.dashboard?.onboardingMode;
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

export function resolveGooglePublicUrl(
  config: Pick<CanonryConfig, "apiUrl" | "publicUrl" | "port">,
  basePath?: string,
): string | undefined {
  const configured = config.publicUrl?.trim();
  if (configured) return configured;

  try {
    const url = new URL(config.apiUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!isLoopbackBindHost(url.hostname)) return undefined;

    const port = config.port && config.port > 0 ? String(config.port) : url.port;
    if (port === "0") return undefined;

    const pathFromApiUrl =
      url.pathname && url.pathname !== "/" ? url.pathname.replace(/\/$/, "") : "";
    const pathFromBasePath = basePath ? basePath.replace(/\/$/, "") : "";
    const pathSuffix = pathFromApiUrl || pathFromBasePath;
    const portSuffix = port ? `:${port}` : "";

    return `${url.protocol}//localhost${portSuffix}${pathSuffix}`;
  } catch {
    return undefined;
  }
}

function cloneGoogleAdsConfig(config: CanonryConfig['googleAds']): CanonryConfig['googleAds'] {
  if (!config) return undefined
  return {
    ...config,
    ...(config.connections === undefined
      ? {}
      : {
          connections: config.connections.map(connection => ({
            ...connection,
            ...(connection.scopes === undefined ? {} : { scopes: [...connection.scopes] }),
          })),
        }),
  }
}

function cloneGtmConfig(config: CanonryConfig['gtm']): CanonryConfig['gtm'] {
  if (!config) return undefined
  return {
    ...config,
    ...(config.connections === undefined
      ? {}
      : {
          connections: config.connections.map(connection => ({
            ...connection,
            ...(connection.scopes === undefined ? {} : { scopes: [...connection.scopes] }),
          })),
        }),
  }
}

/**
 * Private OAuth credentials live outside SQLite. Keep a config snapshot around
 * each mutation so a failed config persistence cannot leave the live process
 * believing a connect or disconnect completed when the durable config did not.
 */
export function createGoogleMarketingConfigCredentialStore(input: {
  config: CanonryConfig
  saveConfigPatch?: (patch: Partial<CanonryConfig>) => void
  env?: NodeJS.ProcessEnv
  randomUUID?: () => string
}) {
  const persistConfigPatch = input.saveConfigPatch ?? saveConfigPatch
  const env = input.env ?? process.env
  const randomUUID = input.randomUUID ?? crypto.randomUUID
  const snapshot = () => ({
    googleAds: cloneGoogleAdsConfig(input.config.googleAds),
    gtm: cloneGtmConfig(input.config.gtm),
  })
  const restore = (previous: ReturnType<typeof snapshot>) => {
    input.config.googleAds = previous.googleAds
    input.config.gtm = previous.gtm
  }

  return {
    hasGoogleAdsDeveloperToken: () => Boolean(
      env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim()
      || getGoogleAdsAuthConfig(input.config).developerToken?.trim(),
    ),
    get: (project: { id: string; name: string }, provider: 'google-ads' | 'gtm') => {
      if (provider === GoogleMarketingProviders['google-ads']) {
        const connection = getGoogleAdsConnection(input.config, project.id)
        if (!connection) return undefined
        return {
          accessToken: connection.accessToken ?? null,
          refreshToken: connection.refreshToken ?? null,
          expiresAt: connection.tokenExpiresAt ?? null,
          scopes: connection.scopes ?? [],
          developerToken: getGoogleAdsAuthConfig(input.config).developerToken ?? null,
          createdAt: connection.createdAt,
          updatedAt: connection.updatedAt,
        }
      }
      const connection = getGtmConnection(input.config, project.id)
      if (!connection) return undefined
      return {
        accessToken: connection.accessToken ?? null,
        refreshToken: connection.refreshToken ?? null,
        expiresAt: connection.tokenExpiresAt ?? null,
        scopes: connection.scopes ?? [],
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      }
    },
    upsert: (
      project: { id: string; name: string },
      provider: 'google-ads' | 'gtm',
      credential: {
        accessToken: string | null
        refreshToken?: string | null
        expiresAt?: string | null
        scopes: string[]
        developerToken?: string | null
        createdAt: string
        updatedAt: string
      },
    ): (() => void) => {
      const previous = snapshot()
      try {
        if (provider === GoogleMarketingProviders['google-ads']) {
          if (credential.developerToken) {
            setGoogleAdsAuthConfig(input.config, { developerToken: credential.developerToken })
          }
          upsertGoogleAdsConnection(input.config, {
            projectId: project.id,
            projectName: project.name,
            credentialGeneration: randomUUID(),
            ...(credential.accessToken ? { accessToken: credential.accessToken } : {}),
            refreshToken: credential.refreshToken ?? null,
            tokenExpiresAt: credential.expiresAt ?? null,
            scopes: credential.scopes,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
          })
        } else {
          upsertGtmConnection(input.config, {
            projectId: project.id,
            projectName: project.name,
            credentialGeneration: randomUUID(),
            ...(credential.accessToken ? { accessToken: credential.accessToken } : {}),
            refreshToken: credential.refreshToken ?? null,
            tokenExpiresAt: credential.expiresAt ?? null,
            scopes: credential.scopes,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
          })
        }
        persistConfigPatch(input.config)
      } catch (error) {
        restore(previous)
        throw error
      }

      // OAuth persists this private state before its public metadata row. The
      // route calls this compensator if that following SQLite transaction
      // cannot commit.
      return () => {
        restore(previous)
        persistConfigPatch(input.config)
      }
    },
    delete: (project: { id: string; name: string }, provider: 'google-ads' | 'gtm') => {
      const previous = snapshot()
      const removed = provider === GoogleMarketingProviders['google-ads']
        ? removeGoogleAdsConnection(input.config, project.id)
        : removeGtmConnection(input.config, project.id)
      if (!removed) return false
      try {
        persistConfigPatch(input.config)
      } catch (error) {
        restore(previous)
        throw error
      }
      return true
    },
  }
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
  /** Live user-global native Canonry plugin state for agent-skills doctor checks. */
  getAgentPluginState?: () => AgentPluginState;
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

  // Which hops in front of this server may be believed about who is calling.
  // Everything that budgets per caller — the sign-in limiter above all — reads
  // `request.ip`, and behind an unconfigured proxy that is the PROXY for
  // everybody, collapsing every caller into one shared bucket. Unset means
  // trust nothing, which is right for the default localhost bind; an operator
  // behind an edge proxy sets CANONRY_TRUST_PROXY to the hop count or the
  // proxy's address.
  const trustProxy = resolveTrustProxy(process.env.CANONRY_TRUST_PROXY);
  const app = Fastify({
    logger,
    trustProxy,
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
      error: describeError(err),
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

  const jobRunner = new JobRunner(opts.db, registry, {
    // The one-time first-sweep thank-you. Lives on the serve console because
    // runs execute here, including the foreground serve that init hands off
    // to. TTY-gated inside, so supervised deployments never see it.
    onFirstActivation: () => maybeShowActivationNotice(),
  });
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

  // Google Ads and Tag Manager share one private OAuth/config boundary while
  // remaining separate public integrations. Provider reads are bounded inside
  // this runtime; only its typed, redacted snapshots cross into SQLite.
  const liveProjectIds = new Set(
    opts.db.select({ id: projects.id }).from(projects).all().map((project) => project.id),
  );
  const removedGoogleMarketingCredentials =
    removeLegacyGoogleAdsConnections(opts.config)
    + removeLegacyGtmConnections(opts.config)
    + removeOrphanedGoogleAdsConnections(opts.config, liveProjectIds)
    + removeOrphanedGtmConnections(opts.config, liveProjectIds);
  if (removedGoogleMarketingCredentials > 0) {
    saveConfigPatch({
      googleAds: opts.config.googleAds,
      gtm: opts.config.gtm,
    });
  }
  const googleMarketingRuntime = createGoogleMarketingRuntime({
    config: opts.config,
    saveConfigPatch,
  });
  const googleMarketingCredentialStore = createGoogleMarketingConfigCredentialStore({
    config: opts.config,
  });

  const prepareGoogleMarketingCredentialDelete = (projectId: string): (() => void) | undefined => {
    // Config storage is outside SQLite, so credential removal is persisted
    // before the DB delete. The compensator below is best-effort only: these
    // stores cannot commit atomically, and a failed compensator deliberately
    // leaves credentials removed (including from memory) rather than making a
    // still-uncertain project usable with stale OAuth material.
    const previousGoogleAdsConnections = opts.config.googleAds?.connections;
    const previousGtmConnections = opts.config.gtm?.connections;
    const restore = () => {
      if (opts.config.googleAds) opts.config.googleAds.connections = previousGoogleAdsConnections;
      if (opts.config.gtm) opts.config.gtm.connections = previousGtmConnections;
    };
    const removedGoogleAds = removeGoogleAdsConnection(opts.config, projectId);
    const removedGtm = removeGtmConnection(opts.config, projectId);
    if (!removedGoogleAds && !removedGtm) return undefined;

    try {
      saveConfigPatch({
        googleAds: opts.config.googleAds,
        gtm: opts.config.gtm,
      });
    } catch (error) {
      restore();
      throw error;
    }

    // If the database transaction fails, try to restore the prior config. A
    // failed restore remains security-first: the project stays in SQLite but
    // its OAuth credentials stay durably removed until it is reconnected.
    return () => {
      restore();
      try {
        saveConfigPatch({
          googleAds: opts.config.googleAds,
          gtm: opts.config.gtm,
        });
      } catch (error) {
        removeGoogleAdsConnection(opts.config, projectId);
        removeGtmConnection(opts.config, projectId);
        throw error;
      }
    };
  };

  const googleMarketingOAuth = {
    authorizationUrl: (input: {
      provider: "google-ads" | "gtm";
      redirectUri: string;
      state: string;
      scopes: readonly string[];
    }) => {
      const auth = input.provider === GoogleMarketingProviders["google-ads"]
        ? getGoogleAdsAuthConfig(opts.config)
        : getGtmAuthConfig(opts.config);
      if (!auth.clientId || !auth.clientSecret) {
        throw new Error("Google OAuth client credentials are not configured.");
      }
      return getGoogleOAuthUrl(auth.clientId, input.redirectUri, [...input.scopes], input.state);
    },
    exchangeCode: async (input: {
      provider: "google-ads" | "gtm";
      code: string;
      redirectUri: string;
    }) => {
      const auth = input.provider === GoogleMarketingProviders["google-ads"]
        ? getGoogleAdsAuthConfig(opts.config)
        : getGtmAuthConfig(opts.config);
      if (!auth.clientId || !auth.clientSecret) {
        throw new Error("Google OAuth client credentials are not configured.");
      }
      const tokens = await exchangeGoogleOAuthCode(
        auth.clientId,
        auth.clientSecret,
        input.code,
        input.redirectUri,
      );
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
          ? new Date(Date.now() + tokens.expires_in * 1_000).toISOString()
          : null,
        scopes: tokens.scope?.split(/\s+/).filter(Boolean)
          ?? [input.provider === GoogleMarketingProviders["google-ads"]
            ? GOOGLE_ADS_OAUTH_SCOPE
            : GTM_READONLY_SCOPE],
      };
    },
  };

  const googleMarketingLiveReader = {
    listGoogleAdsCustomers: (project: { id: string; name: string }) =>
      googleMarketingRuntime.listGoogleAdsCustomers(project),
    listGtmAccounts: (project: { id: string; name: string }) =>
      googleMarketingRuntime.listGtmAccounts(project),
    listGtmContainers: (project: { id: string; name: string }, accountId: string) =>
      googleMarketingRuntime.listGtmContainers(project, accountId),
    listGtmWorkspaces: (
      project: { id: string; name: string },
      accountId: string,
      containerId: string,
    ) => googleMarketingRuntime.listGtmWorkspaces(project, accountId, containerId),
  };

  const runGoogleAdsMarketingSync = (runId: string, projectId: string): void => {
    executeGoogleAdsMarketingSync(opts.db, googleMarketingRuntime, runId, projectId)
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch(() => {
        app.log.error({ runId, projectId }, "Google Ads sync failed");
      });
  };
  const runGtmMarketingSync = (runId: string, projectId: string): void => {
    executeGtmMarketingSync(opts.db, googleMarketingRuntime, runId, projectId)
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch(() => {
        app.log.error({ runId, projectId }, "GTM sync failed");
      });
  };

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
  // run row is created by the caller. This runs the full crawl and audit, then
  // hands off to the post-run coordinator on completion.
  //
  // This map deliberately lives only in `canonry serve`: it is the bridge from
  // a durable cancel mutation to the matching in-process fetch controller.
  const siteAuditAbortControllers = new Map<string, AbortController>();
  const runSiteAudit = (
    runId: string,
    projectId: string,
    auditOpts?: {
      sitemapUrl?: string;
      limit?: number;
      maxPages?: number;
      maxEdges?: number;
      maxDepth?: number;
      checkDeadLinks?: boolean;
    },
  ): void => {
    const controller = new AbortController();
    siteAuditAbortControllers.set(runId, controller);
    executeSiteAudit(opts.db, runId, projectId, { ...(auditOpts ?? {}), signal: controller.signal })
      .then(() => runCoordinator.onRunCompleted(runId, projectId))
      .catch((err: unknown) => {
        app.log.error({ runId, err }, "Site audit failed");
      })
      .finally(() => {
        if (siteAuditAbortControllers.get(runId) === controller) {
          siteAuditAbortControllers.delete(runId);
        }
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

  const normalizeAdsAccount = (account: Awaited<ReturnType<typeof getAdAccount>>) =>
    adsAccountDtoSchema.parse({
      id: account.id,
      name: account.name,
      status: account.status,
      currencyCode: account.currency_code ?? null,
      timezone: account.timezone ?? null,
      url: account.url ?? null,
      reviewStatus: account.review?.status ?? null,
      integrityReviewStatus: account.account_integrity_review?.review?.status ?? null,
      integrityDecision: account.account_integrity_review?.details?.decision ?? null,
    });

  // Validates an SDK key by reading its own ad account from the upstream API.
  const verifyAdsAccount = async (apiKey: string) => {
    const account = normalizeAdsAccount(await getAdAccount(apiKey));
    return {
      id: account.id,
      name: account.name,
      status: account.status,
      currencyCode: account.currencyCode,
      timezone: account.timezone,
      reviewStatus: account.reviewStatus,
      integrityReviewStatus: account.integrityReviewStatus,
      integrityDecision: account.integrityDecision,
    };
  };

  const adsReader = {
    getAccount: async (apiKey: string) => normalizeAdsAccount(await getAdAccount(apiKey)),
    searchGeo: async (apiKey: string, input: { q: string; limit: number }) => {
      const response = await searchGeoLocations(apiKey, input.q, input.limit);
      return adsGeoSearchResponseSchema.parse({
        count: response.count,
        query: response.query,
        results: response.results.map((location) => ({
          id: location.id,
          type: location.type,
          canonicalName: location.canonical_name,
          countryCode: location.country_code,
          name: location.name,
          regionCode: location.region_code,
        })),
      });
    },
    listConversionPixels: async (apiKey: string) => {
      const pixels = await listConversionPixels(apiKey);
      return adsConversionPixelListResponseSchema.parse({
        pixels: pixels.map((pixel) => ({
          id: pixel.id,
          clientType: pixel.client_type,
          name: pixel.name,
          pixelId: pixel.pixel_id,
        })),
      });
    },
    listConversionEventSettings: async (apiKey: string) => {
      const eventSettings = await listConversionEventSettings(apiKey);
      return adsConversionEventSettingListResponseSchema.parse({
        eventSettings: eventSettings.map((eventSetting) => ({
          id: eventSetting.id,
          name: eventSetting.name,
          eventType: eventSetting.event_type,
          customEventName: eventSetting.custom_event_name,
          attributionWindowDays: eventSetting.attribution_window_days,
          adAccountId: eventSetting.ad_account_id,
          sourceIds: eventSetting.source_ids,
          sources: eventSetting.sources,
          archived: eventSetting.archived,
          version: eventSetting.version,
        })),
      });
    },
  };

  const adsEntityResult = (entity: {
    id: string;
    name: string;
    status: string;
    updated_at: number;
    review_status?: string;
    creative?: {
      title?: string | null;
      body?: string | null;
      target_url?: string | null;
      file_id?: string | null;
    } | null;
  }) => ({
    id: entity.id,
    name: entity.name,
    status: entity.status,
    updatedAt: entity.updated_at,
    reviewStatus: entity.review_status ?? null,
    creative:
      typeof entity.creative?.title === "string" &&
      typeof entity.creative.body === "string" &&
      typeof entity.creative.target_url === "string" &&
      typeof entity.creative.file_id === "string"
        ? {
            title: entity.creative.title,
            body: entity.creative.body,
            targetUrl: entity.creative.target_url,
            fileId: entity.creative.file_id,
          }
        : null,
  });

  const adsCampaignEntityResult = (entity: Awaited<ReturnType<typeof getCampaign>>) => ({
    ...adsEntityResult(entity),
    description: entity.description,
    startTime: entity.start_time,
    endTime: entity.end_time,
    lifetimeSpendLimitMicros: entity.budget?.lifetime_spend_limit_micros ?? null,
    locationIds: entity.targeting?.locations?.include?.map((location) => location.id) ?? [],
    biddingType: entity.bidding_type,
    conversionEventSettingIds: entity.conversion_event_setting_ids,
  });

  const adsAdGroupEntityResult = (
    entity: Awaited<ReturnType<typeof getAdGroup>>,
    campaignId?: string,
  ) => ({
    ...adsEntityResult(entity),
    description: entity.description,
    campaignId: campaignId ?? null,
    contextHints: entity.context_hints,
    maxBidMicros: entity.bidding_config?.max_bid_micros ?? null,
    billingEventType: entity.bidding_config?.billing_event_type ?? null,
  });

  const adsAdEntityResult = (
    entity: Awaited<ReturnType<typeof getAd>>,
    adGroupId?: string,
  ) => ({
    ...adsEntityResult(entity),
    adGroupId: adGroupId ?? null,
  });

  const adsOperator = {
    uploadImage: async (apiKey: string, imageUrl: string) => {
      const result = await uploadImageFromUrl(apiKey, imageUrl);
      return { fileId: result.file_id };
    },
    getCampaign: async (apiKey: string, id: string) => adsCampaignEntityResult(await getCampaign(apiKey, id)),
    listCampaigns: async (apiKey: string) => (await listCampaigns(apiKey)).map(adsCampaignEntityResult),
    createCampaign: async (apiKey: string, input: {
      name: string;
      description?: string;
      startTime?: number;
      endTime?: number;
      lifetimeSpendLimitMicros: number;
      locationIds: string[];
      biddingType: AdsCampaignBiddingType;
      conversionEventSettingIds?: string[];
    }) => adsCampaignEntityResult(await createCampaign(apiKey, {
      name: input.name,
      description: input.description,
      start_time: input.startTime,
      end_time: input.endTime,
      status: OpenAiAdsWriteStatuses.paused,
      budget: { lifetime_spend_limit_micros: input.lifetimeSpendLimitMicros },
      bidding_type: input.biddingType,
      conversion_event_setting_ids: input.conversionEventSettingIds,
      targeting: { locations: { include: input.locationIds.map((id) => ({ id })) } },
    })),
    updateCampaign: async (apiKey: string, id: string, input: {
      name?: string;
      description?: string | null;
      startTime?: number | null;
      endTime?: number | null;
      lifetimeSpendLimitMicros?: number;
      locationIds?: string[];
    }) => adsCampaignEntityResult(await updateCampaign(apiKey, id, {
      name: input.name,
      description: input.description,
      start_time: input.startTime,
      end_time: input.endTime,
      budget: input.lifetimeSpendLimitMicros === undefined
        ? undefined
        : { lifetime_spend_limit_micros: input.lifetimeSpendLimitMicros },
      targeting: input.locationIds === undefined
        ? undefined
        : { locations: { include: input.locationIds.map((locationId) => ({ id: locationId })) } },
    })),
    activateCampaign: async (apiKey: string, id: string) =>
      adsCampaignEntityResult(await activateCampaign(apiKey, id)),
    pauseCampaign: async (apiKey: string, id: string) => adsCampaignEntityResult(await pauseCampaign(apiKey, id)),
    archiveCampaign: async (apiKey: string, id: string) =>
      adsCampaignEntityResult(await archiveCampaign(apiKey, id)),
    getAdGroup: async (apiKey: string, id: string) => adsAdGroupEntityResult(await getAdGroup(apiKey, id)),
    listAdGroups: async (apiKey: string, campaignId: string) =>
      (await listAdGroups(apiKey, campaignId)).map((entity) => adsAdGroupEntityResult(entity, campaignId)),
    createAdGroup: async (apiKey: string, input: {
      campaignId: string;
      name: string;
      description?: string;
      contextHints: string[];
      maxBidMicros: number;
      billingEventType: AdsAdGroupBillingEventType;
    }) => adsAdGroupEntityResult(await createAdGroup(apiKey, {
      campaign_id: input.campaignId,
      name: input.name,
      description: input.description,
      context_hints: input.contextHints,
      status: OpenAiAdsWriteStatuses.paused,
      bidding_config: {
        billing_event_type: input.billingEventType,
        max_bid_micros: input.maxBidMicros,
      },
    })),
    updateAdGroup: async (apiKey: string, id: string, input: {
      name?: string;
      description?: string | null;
      contextHints?: string[];
      maxBidMicros?: number;
      billingEventType?: AdsAdGroupBillingEventType;
    }) => {
      let biddingConfig: OpenAiAdsBiddingConfigRequest | undefined;
      if (input.maxBidMicros !== undefined) {
        if (input.billingEventType === undefined) {
          throw new Error('Ad group max-bid updates require the current billing event type');
        }
        biddingConfig = {
          billing_event_type: input.billingEventType,
          max_bid_micros: input.maxBidMicros,
        };
      }
      return adsAdGroupEntityResult(await updateAdGroup(apiKey, id, {
        name: input.name,
        description: input.description,
        context_hints: input.contextHints,
        bidding_config: biddingConfig,
      }));
    },
    activateAdGroup: async (apiKey: string, id: string) =>
      adsAdGroupEntityResult(await activateAdGroup(apiKey, id)),
    pauseAdGroup: async (apiKey: string, id: string) => adsAdGroupEntityResult(await pauseAdGroup(apiKey, id)),
    archiveAdGroup: async (apiKey: string, id: string) =>
      adsAdGroupEntityResult(await archiveAdGroup(apiKey, id)),
    getAd: async (apiKey: string, id: string) => adsAdEntityResult(await getAd(apiKey, id)),
    listAds: async (apiKey: string, adGroupId: string) =>
      (await listAds(apiKey, adGroupId)).map((entity) => adsAdEntityResult(entity, adGroupId)),
    createAd: async (apiKey: string, input: {
      adGroupId: string;
      name: string;
      creative: { title: string; body: string; targetUrl: string; fileId: string };
    }) => adsAdEntityResult(await createAd(apiKey, {
      ad_group_id: input.adGroupId,
      name: input.name,
      status: OpenAiAdsWriteStatuses.paused,
      creative: {
        type: OpenAiAdsCreativeTypes.chatCard,
        title: input.creative.title,
        body: input.creative.body,
        target_url: input.creative.targetUrl,
        file_id: input.creative.fileId,
      },
    })),
    updateAd: async (apiKey: string, id: string, input: {
      name?: string;
      creative?: { title: string; body: string; targetUrl: string; fileId: string };
    }) => adsAdEntityResult(await updateAd(apiKey, id, {
      name: input.name,
      creative: input.creative
        ? {
            type: OpenAiAdsCreativeTypes.chatCard,
            title: input.creative.title,
            body: input.creative.body,
            target_url: input.creative.targetUrl,
            file_id: input.creative.fileId,
          }
        : undefined,
    })),
    activateAd: async (apiKey: string, id: string) => adsAdEntityResult(await activateAd(apiKey, id)),
    pauseAd: async (apiKey: string, id: string) => adsAdEntityResult(await pauseAd(apiKey, id)),
    archiveAd: async (apiKey: string, id: string) => adsAdEntityResult(await archiveAd(apiKey, id)),
  };

  const adsLiveEntity = (entity: {
    id: string;
    name: string;
    status: string;
    updated_at: number;
  }, extra?: { reviewStatus?: string | null; mode?: string | null }) => ({
    id: entity.id,
    name: entity.name,
    status: entity.status,
    reviewStatus: extra?.reviewStatus ?? null,
    mode: extra?.mode ?? null,
    updatedAt: entity.updated_at,
  });

  const adsLiveMetricRow = (row: Awaited<ReturnType<typeof getCampaignInsights>>[number]) => ({
    date: row.readable_time ?? null,
    startTime: row.start_time ?? null,
    endTime: row.end_time ?? null,
    impressions: row.impressions ?? null,
    clicks: row.clicks ?? null,
    // Provider units: the insights API returns decimal currency for spend.
    spend: row.spend ?? null,
    conversions: row.conversions ?? null,
    ctr: row.ctr ?? null,
    cpc: row.cpc ?? null,
    cpm: row.cpm ?? null,
  });

  // Read-only live-delivery surfaces. It requests the SAME insight fields as
  // ads-sync so a live row and a stored rollup measure the same quantities, and
  // the SAME range for every insight call in one walk: both ends of that range
  // come from the route's request, so this reader never reads the clock.
  //
  // It also reads the day in progress the SAME way ads-sync does, through
  // `readInsightDays`. The stored side carries that day, so a live side that
  // omitted it would report a stored-only day as drift on every read. The
  // date it looks for comes from the route's frozen anchor, never from now.
  const adsLiveInsightDays = (
    read: (options: OpenAiAdsInsightsOptions) => Promise<OpenAiAdsInsightRow[]>,
    request: { startDate: string; fetchedAtMs: number; timezone: string },
    rangedFields: readonly string[],
    inProgressFields: readonly string[],
  ) =>
    readInsightDays({
      read,
      rangedFields,
      inProgressFields,
      timeRanges: [liveAdsInsightHourRange(request)],
      inProgressDate: accountLocalDate(new Date(request.fetchedAtMs), request.timezone),
    });

  const adsLiveMetricRows = (read: {
    closedDays: OpenAiAdsInsightRow[];
    inProgressDay: OpenAiAdsInsightRow | null;
  }) =>
    [...read.closedDays, ...(read.inProgressDay ? [read.inProgressDay] : [])].map(adsLiveMetricRow);

  const adsLiveDeliveryReader = {
    listCampaigns: async (apiKey: string) =>
      (await listCampaigns(apiKey)).map((campaign) => adsLiveEntity(campaign, { mode: campaign.mode })),
    listAdGroups: async (apiKey: string, campaignId: string) =>
      (await listAdGroups(apiKey, campaignId)).map((adGroup) => adsLiveEntity(adGroup)),
    listAds: async (apiKey: string, adGroupId: string) =>
      (await listAds(apiKey, adGroupId)).map((ad) =>
        adsLiveEntity(ad, { reviewStatus: ad.review_status ?? ad.review?.status ?? null }),
      ),
    campaignInsights: async (
      apiKey: string,
      campaignId: string,
      request: { startDate: string; fetchedAtMs: number; timezone: string },
    ) =>
      adsLiveMetricRows(await adsLiveInsightDays(
        (options) => getCampaignInsights(apiKey, campaignId, options),
        request,
        CAMPAIGN_INSIGHT_FIELDS,
        CAMPAIGN_IN_PROGRESS_INSIGHT_FIELDS,
      )),
    adGroupInsights: async (
      apiKey: string,
      adGroupId: string,
      request: { startDate: string; fetchedAtMs: number; timezone: string },
    ) =>
      adsLiveMetricRows(await adsLiveInsightDays(
        (options) => getAdGroupInsights(apiKey, adGroupId, options),
        request,
        AD_GROUP_INSIGHT_FIELDS,
        AD_GROUP_IN_PROGRESS_INSIGHT_FIELDS,
      )),
  };

  const scheduler = new Scheduler(opts.db, {
    onRunCreated: (runId, projectId, providers, location) => {
      jobRunner
        .executeRun(runId, projectId, providers, location)
        .catch((err: unknown) => {
          app.log.error({ runId, err }, "Scheduled job runner failed");
        });
    },
    // Same source of truth the HTTP routes use, so a scheduled sweep resolves
    // "all configured providers" exactly as a hand-triggered one does.
    getRunnableProviderNames: () =>
      registry.getAll().map((provider) => provider.adapter.name),
    getEffectiveProviderModels: () => effectiveProviderModels(registry),
    onTrafficSyncRequested: (projectName, sourceId) => {
      // Reuse the same in-process API client Aero uses. The traffic-sync
      // endpoint owns run-row creation, dedupe, rollup writes, and emits
      // the `traffic.synced` telemetry — the scheduler only triggers it.
      aeroClient.trafficSync(projectName, sourceId).catch((err: unknown) => {
        app.log.error(
          {
            projectName,
            sourceId,
            err: describeError(err),
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
    onDoctorRequested: (projectName) => {
      // Run the health checks and notify only on a transition. This is the loop
      // that was missing: the checks existed and nothing executed them, so a
      // degraded instrument kept emitting `run.completed` and looked healthy.
      void (async () => {
        try {
          const report = await aeroClient.runDoctor({ project: projectName });
          const project = opts.db
            .select()
            .from(projects)
            .where(eq(projects.name, projectName))
            .get();
          if (!project) {
            app.log.warn({ projectName }, "doctor schedule fired for an unknown project");
            return;
          }
          await notifier.onHealthChecked(project.id, {
            checks: report.checks,
            checkedAt: report.generatedAt,
          });
        } catch (err: unknown) {
          // A health check that cannot run must not take the scheduler down,
          // but it also must not look like a clean pass — leaving the stored
          // state untouched means the next successful pass still sees the real
          // previous status and transitions correctly.
          app.log.warn({ projectName, err }, "scheduled doctor pass failed");
        }
      })();
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
                err: describeError(err),
              },
              "Scheduled backlinks sync failed",
            );
          });
      })();

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
    upsertConnection: (record: CloudflareTrafficConnectionConfigEntry) => {
      const updated = upsertCloudflareTrafficConnection(opts.config, record);
      saveConfigPatch(opts.config);
      return updated;
    },
    deleteConnection: (projectName: string) => {
      const removed = removeCloudflareTrafficConnection(opts.config, projectName);
      if (removed) saveConfigPatch(opts.config);
      return removed;
    },
    deleteConnectionBySourceId: (sourceId: string) => {
      const removed = removeCloudflareTrafficConnectionBySourceId(
        opts.config,
        sourceId,
      );
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
  const unsupportedProjectTabs = unsupportedEmbedProjectTabs(embed.projectTabs);
  if (embed.enabled && unsupportedProjectTabs.length > 0) {
    app.log.warn(
      {
        projectTabs: unsupportedProjectTabs,
        supportedProjectTabs: [...SERVER_ENFORCED_EMBED_PROJECT_TABS],
      },
      "Embed project tabs include unsupported values; API reads for those tabs will be blocked",
    );
  }
  const dashboardRequirePassword = resolveDashboardRequirePassword(process.env, opts.config);
  const dashboardShowResourceLinks = resolveDashboardShowResourceLinks(process.env, opts.config);
  const dashboardShowUpdateNotification = resolveDashboardShowUpdateNotification(process.env, opts.config);
  const dashboardOnboardingMode = resolveDashboardOnboardingMode(process.env, opts.config);
  app.log.info(
    { dashboardRequirePassword },
    "Dashboard password gate resolved",
  );

  // Register API routes.
  // When a basePath is set, routes are registered at `${basePath}api/v1` so they
  // match requests forwarded by a reverse proxy that does NOT strip the prefix
  // (e.g. Caddy `reverse_proxy localhost:4100` without `uri strip_prefix`).
  // If the proxy does strip the prefix, set CANONRY_BASE_PATH to empty/unset and
  // let the proxy handle path rewriting instead.
  const apiPrefix = basePath ? `${basePath}api/v1` : "/api/v1";
  // One checker, shared by /auth/login and the OAuth consent page, so the two
  // sign-in doors carry the same brute-force and threadpool budgets.
  const credentialChecker = createCredentialChecker({
    db: opts.db,
    trustProxyConfigured: trustProxy !== false,
  })

  const googlePublicUrl = resolveGooglePublicUrl(opts.config, basePath);
  // The OAuth issuer is an ORIGIN, never a base path: RFC 9728 inserts the
  // well-known segment between host and path, so the document lives at the
  // root of the host regardless of where the resource itself is mounted.
  const publicOrigin = (() => {
    if (!googlePublicUrl) return undefined;
    try {
      return new URL(googlePublicUrl).origin;
    } catch {
      return undefined;
    }
  })();
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

  // Once this install has named accounts, the single shared dashboard password
  // is no longer a way in: it carries the root key's authority and would hand
  // everyone the same access the roles were just created to separate. These
  // three routes therefore step aside and point at the sign-in form instead of
  // half-working.
  const namedAccountsInUse = () => anyUsersExist(opts.db);
  const NAMED_ACCOUNTS_MESSAGE =
    "This install uses named accounts. Sign in with your name and password.";

  app.get(apiPrefix + "/session", async (request, reply) => {
    if (namedAccountsInUse()) {
      return reply.send({ authenticated: false, setupRequired: false });
    }
    if (!dashboardRequirePassword) {
      return reply.send({ authenticated: true, setupRequired: false });
    }
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
    if (namedAccountsInUse()) {
      const err = forbidden(NAMED_ACCOUNTS_MESSAGE);
      return reply.status(err.statusCode).send(err.toJSON());
    }
    if (!dashboardRequirePassword) {
      return reply.send({ authenticated: true, setupRequired: false });
    }
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
    if (namedAccountsInUse()) {
      const err = forbidden(NAMED_ACCOUNTS_MESSAGE);
      return reply.status(err.statusCode).send(err.toJSON());
    }
    if (!dashboardRequirePassword) {
      return reply.send({ authenticated: true, setupRequired: false });
    }
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
            message: "Server API key not found — run canonry bootstrap",
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

  const dispatchResearchRun = (runId: string, projectId: string) => {
    executeResearchRun(opts.db, registry, runId, projectId).catch((err: unknown) => {
      app.log.error({ runId, err }, 'Research run failed');
    });
  };

  await app.register(apiRoutes, {
    db: opts.db,
    routePrefix: apiPrefix,
    skipAuth: false,
    sessionCookieName: SESSION_COOKIE_NAME,
    resolveSessionApiKeyId,
    // Named-account sessions ride the same cookie path as the older dashboard
    // cookie, so a sub-path mount behaves the same for both. `secure` is only
    // forced ON: the config flag knows an https public URL when there is one,
    // but it cannot see a reverse proxy terminating TLS in front of a
    // plain-http bind. Passing `false` there would mark the cookie insecure on
    // exactly the deployment that needs it most, so an unset flag defers to
    // how the request actually arrived.
    userSessionCookie: {
      path: sessionCookiePath,
      ...(sessionCookieSecure ? { secure: true } : {}),
    },
    // Whether an operator has declared which hops to believe. The per-caller
    // sign-in budget depends on this being the truth rather than something
    // inferred from a header the caller controls.
    trustProxyConfigured: trustProxy !== false,
    ...(embed.enabled && embed.projectTabs ? { embedProjectTabs: embed.projectTabs } : {}),
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
    getAgentPluginState: opts.getAgentPluginState,
    // Local canonry serve runs on the operator's machine, where pointing a
    // webhook at localhost (Discord test container, Pipedream-mock dev server,
    // etc.) is a legitimate workflow. Default to allowing it for the local
    // installer; cloud deployments inherit the secure default of `false` by
    // not passing this option. Override with CANONRY_ALLOW_LOOPBACK_WEBHOOKS=0.
    allowLoopbackWebhooks: process.env.CANONRY_ALLOW_LOOPBACK_WEBHOOKS !== "0",
    // Wall-clock budget for one incremental Vercel drain. This is the only lever
    // that decides whether a source catches up or falls further behind, and it
    // was previously reachable only from tests, so a source losing ground could
    // not be rescued without shipping code. Unset keeps the built-in default.
    vercelSyncDeadlineMs: resolveVercelSyncDeadlineMs(process.env),
    // Local-only Aero agent routes. Registered here so they inherit api-routes'
    // auth plugin — bare `registerAgentRoutes(app, ...)` would skip auth.
    credentials: credentialChecker,
    oauthResourceUrl: publicOrigin
      ? `${publicOrigin}${`${basePath ?? "/"}api/v1/mcp`.replace("//", "/")}`
      : undefined,
    registerAuthenticatedRoutes: async (scope) => {
      // MCP over Streamable HTTP. Registered HERE, not on the root app, so it
      // inherits the api-routes auth hook — the root app has none, and a route
      // mounted there would serve MCP unauthenticated.
      registerMcpHttpRoutes(scope, { selfApiUrl: opts.config.apiUrl, issuer: publicOrigin, db: opts.db });
      // Operator-only OAuth routes: inside the authenticated scope, behind the
      // api-key auth and the admin gate, while /oauth/* stays public.
      registerOAuthAdminRoutes(scope, { db: opts.db });
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
    getGoogleMarketingDoctorInput: (ctx) => {
      if (!ctx.project) return null;
      const googleAds = opts.db.select().from(googleAdsConnections)
        .where(eq(googleAdsConnections.projectId, ctx.project.id)).get();
      const gtm = opts.db.select().from(gtmConnections)
        .where(eq(gtmConnections.projectId, ctx.project.id)).get();
      const googleAdsCredential = getGoogleAdsConnection(opts.config, ctx.project.id);
      const gtmCredential = getGtmConnection(opts.config, ctx.project.id);
      // Disconnect deliberately retains redacted evidence rows while deleting
      // credentials and clearing selection metadata. Doctor must mirror the
      // public status routes: a retained row without an active OAuth access
      // token is not a broken connection.
      const googleAdsConnected = Boolean(googleAdsCredential?.accessToken);
      const gtmConnected = Boolean(gtmCredential?.accessToken);
      return {
        googleAds: googleAds && googleAdsConnected
          ? {
              credentialsPresent: Boolean(
                googleAdsCredential?.accessToken || googleAdsCredential?.refreshToken,
              ),
              grantedScopes: googleAds.scopes,
              selectedLoginCustomerId: googleAds.selectedLoginCustomerId,
              selectedCustomerId: googleAds.selectedCustomerId,
              latestSnapshotAt: [
                googleAds.lastInventorySnapshotAt,
                googleAds.lastMetricsSnapshotAt,
              ].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
            }
          : null,
        gtm: gtm && gtmConnected
          ? {
              credentialsPresent: Boolean(gtmCredential?.accessToken || gtmCredential?.refreshToken),
              grantedScopes: gtm.scopes,
              selectedAccountId: gtm.selectedAccountId,
              selectedContainerId: gtm.selectedContainerId,
              selectedWorkspaceId: gtm.selectedWorkspaceId,
              latestSnapshotAt: gtm.lastSnapshotAt,
            }
          : null,
      };
    },
    googleConnectionStore,
    googleStateSecret,
    publicUrl: googlePublicUrl,
    googleMarketingCredentialStore,
    googleMarketingOAuth,
    googleMarketingOAuthScopes: {
      [GoogleMarketingProviders["google-ads"]]: [GOOGLE_ADS_OAUTH_SCOPE],
      [GoogleMarketingProviders.gtm]: [GTM_READONLY_SCOPE],
    },
    googleMarketingLiveReader,
    assessConversionTrackingIntegrity: ({ contract, googleAdsSnapshot, gtmSnapshot }) => {
      const googleAdsInventory = googleAdsSnapshot?.payload.kind === "inventory"
        ? googleAdsSnapshot.payload.data
        : null;
      const gtmLiveGraph = gtmSnapshot?.payload.kind === "container"
        ? gtmSnapshot.payload.data.live
        : gtmSnapshot?.payload.kind === "live"
          ? gtmSnapshot.payload.data
          : null;
      return assessConversionTrackingIntegrity({
        contract,
        googleAdsInventory,
        googleAdsEvidenceId: googleAdsSnapshot?.metadata.id,
        gtmLiveGraph,
        gtmEvidenceId: gtmSnapshot?.metadata.id,
        evaluatedAt: new Date().toISOString(),
      });
    },
    onGoogleAdsSyncRequested: runGoogleAdsMarketingSync,
    onGtmSyncRequested: runGtmMarketingSync,
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
        // itself inspects NO URLs, so this chain is the only thing that can
        // move index coverage — which is why a user-initiated sync is not
        // subject to the hour-long scheduled spacing.
        .then(() =>
          maybeRefreshGscCoverage(opts.db, opts.config, projectId, undefined, Date.now(), {
            userInitiated: runWasUserInitiated(opts.db, runId),
          }),
        )
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
    adsReader,
    adsLiveDeliveryReader,
    // Reporting only: lets the route state the true upstream HTTP ceiling
    // (reader-call budget x pages per reader call) instead of implying that a
    // reader call is one request.
    adsLiveDeliveryMaxPagesPerReaderCall: OPENAI_ADS_MAX_PAGES,
    adsOperator,
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
        buyerDescription: input.buyerDescription,
        seedProviders: input.seedProviders,
        dedupThreshold: input.dedupThreshold,
        maxProbes: input.maxProbes,
        probeConcurrency: input.probeConcurrency,
        locations: input.locations,
      })
        .then(() => runCoordinator.onRunCompleted(input.runId, input.projectId))
        .catch((err: unknown) => {
          app.log.error({ runId: input.runId, err }, "Discovery run failed");
        });
    },
    onResearchRunRequested: dispatchResearchRun,
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
      auditOpts?: {
        sitemapUrl?: string;
        limit?: number;
        maxPages?: number;
        maxEdges?: number;
        maxDepth?: number;
        checkDeadLinks?: boolean;
      },
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
      modelConfigurable: a.mode === "api",
      defaultModel: a.modelRegistry.defaultModel,
      knownModels: a.modelRegistry.knownModels,
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
            return maybeRefreshGscCoverage(
              opts.db,
              opts.config,
              projectId,
              undefined,
              Date.now(),
              { userInitiated: runWasUserInitiated(opts.db, runId) },
            );
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
    onRunCancelled: (runId: string) => {
      const controller = siteAuditAbortControllers.get(runId);
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error("Cancelled by user"));
      }
    },
    getRunnableProviderNames: () =>
      registry.getAll().map((provider) => provider.adapter.name),
    getEffectiveProviderModels: () => effectiveProviderModels(registry),
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
    onProjectCreated: (projectId: string) => {
      if (ensureDefaultHealthSchedule(opts.db, projectId)) {
        scheduler.upsert(projectId, SchedulableRunKinds.doctor);
      }
    },
    onProjectDeleting: prepareGoogleMarketingCredentialDelete,
    onProjectDeleted: (projectId: string) => {
      scheduler.removeAllForProject(projectId);
      const removedGoogleAds = removeGoogleAdsConnection(opts.config, projectId);
      const removedGtm = removeGtmConnection(opts.config, projectId);
      if (removedGoogleAds || removedGtm) {
        saveConfigPatch({
          googleAds: opts.config.googleAds,
          gtm: opts.config.gtm,
        });
      }
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
    recordOnboardingEvent: (event) => {
      const { event: eventName, eventId, ...properties } = event;
      trackEvent(eventName, properties, { source: "dashboard", eventId });
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
    const injectConfig = (
      html: string,
      projectTabsOverride?: string | string[],
      themeOverride?: string | string[],
      renderTokenOverride?: string | string[],
    ): string => {
      const clientConfig: Record<string, unknown> = {};
      if (basePath) clientConfig.basePath = basePath;
      // Keep the default client config byte-for-byte unchanged. Only inject the
      // dashboard block when the operator opts out of dashboard chrome.
      const dashboardConfig: Record<string, boolean | string> = {};
      if (dashboardOnboardingMode) {
        dashboardConfig.onboardingMode = dashboardOnboardingMode;
      }
      if (!dashboardShowResourceLinks) {
        dashboardConfig.showResourceLinks = false;
      }
      if (!dashboardShowUpdateNotification) {
        dashboardConfig.showUpdateNotification = false;
      }
      // The agent kill-switch removes the routes; without telling the browser,
      // the command bar still rendered and every request 404'd in front of the
      // operator. The dashboard has to know the capability is gone, not discover
      // it one failed fetch at a time.
      if (!agentEnabled) {
        dashboardConfig.showAgentBar = false;
      }
      if (Object.keys(dashboardConfig).length > 0) {
        clientConfig.dashboard = dashboardConfig;
      }
      // Embed block is appended LAST and only when enabled, so the default
      // (non-embed) serve emits byte-for-byte the same `{}` / `{basePath}`.
      // `projectTabs` + `theme` may be overridden PER REQUEST by the
      // X-Canonry-Embed-Tabs / X-Canonry-Embed-Theme headers the Embed v2 /e
      // proxy sets per dashboard. The proxy also sets X-Canonry-Embed-Render-Token
      // for the initial HTML so the SPA can call back through /e/api/v1 without
      // seeing the engine key. The end client cannot reach this loopback engine
      // to set any of these headers; absent headers keep the boot config.
      if (embed.enabled) {
        const embedClient = embedClientConfigForRequest(embed, projectTabsOverride, themeOverride, renderTokenOverride);
        if (embedClient) clientConfig.embed = embedClient;
      }

      // serializeForInlineScript (NOT bare JSON.stringify): escapes < > & and the
      // JS line separators so a value containing </script> can never break out of
      // this inline script. The per-request projectTabs override is the first
      // request-derived value to reach here, so this is a hard requirement.
      const configScript = `<script>window.__CANONRY_CONFIG__=${serializeForInlineScript(clientConfig)}</script>`;
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
      return reply
        .type("text/html")
        .send(
          injectConfig(
            html,
            reply.request.headers["x-canonry-embed-tabs"],
            reply.request.headers["x-canonry-embed-theme"],
            reply.request.headers["x-canonry-embed-render-token"],
          ),
        );
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
        const error = notFound("API route", url);
        return reply.status(error.statusCode).send(error.toJSON());
      }

      // Machine-facing shapes the SPA does not own. Both currently answer 200
      // with the app shell, which is worse than a 404 in different ways:
      //
      // - `/.well-known/*` carries protocol discovery. Per RFC 9728 s3.1 the
      //   protected-resource document for a resource at `/t/demo/mcp` lives at
      //   `/.well-known/oauth-protected-resource/t/demo/mcp` — the well-known
      //   segment is INSERTED between host and path, it is not appended under
      //   the base path. Either way it lands under a leading dotted segment
      //   here. A client handed index.html with a 200 cannot distinguish "no
      //   metadata here" from "metadata is malformed", so discovery fails in
      //   the most confusing way available. This is a hard prerequisite for
      //   serving MCP over OAuth, not polish.
      // - Dotfile probes (/.env, /.env.local, /.git/config) are scanners, and a
      //   200 tells them the path exists.
      //
      // ONE rule covers both: any dot-prefixed SEGMENT, checked on the raw path
      // AND on its percent-decoded form. Both halves are load-bearing:
      //   - any segment, not just the last, because /.git/config ends in
      //     "config" and the RFC 9728 document above ends in "mcp";
      //   - decoded as well as raw, because `/%2eenv` and `/%2Eenv` otherwise
      //     sail straight through to the SPA. Decoding also collapses `%2F`,
      //     so `/foo%2F.env` cannot smuggle a dotted segment past the split.
      // Decode exactly once and never in a loop: repeated decoding is its own
      // bypass primitive. A malformed escape throws, and falls back to the raw
      // check rather than opening the path.
      //
      // Deliberately NOT a general "does the SPA own this?" heuristic: the
      // dashboard owns arbitrary deep links like /projects/<name>, and those
      // must keep returning the document.
      const hasDotSegment = (candidate: string): boolean =>
        candidate.split("/").some((segment) => segment.startsWith("."));
      let decodedUrl = url;
      try {
        decodedUrl = decodeURIComponent(url);
      } catch {
        // Malformed percent-encoding. Keep the raw check below.
      }
      if (hasDotSegment(url) || hasDotSegment(decodedUrl)) {
        const error = notFound("Route", url);
        return reply.status(error.statusCode).send(error.toJSON());
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
  // OAuth 2.1, mounted at the ROOT and outside the api-key auth scope: a client
  // with no credential must be able to discover where to get one. Registered
  // only when the instance knows its own public origin, since every URL in the
  // metadata documents has to be absolute and externally reachable.
  if (publicOrigin) {
    registerOAuthRoutes(app, {
      db: opts.db,
      issuer: publicOrigin,
      resourcePaths: mcpTransportPaths().map((suffix) =>
        `${basePath ?? "/"}api/v1${suffix}`.replace("//", "/"),
      ),
      resolveUser: (request) => {
        const cookies = parseCookieHeader(request.headers.cookie);
        const token = cookies[USER_SESSION_COOKIE_NAME];
        if (!token) return null;
        const resolved = resolveUserSession(opts.db, token);
        return resolved ? { id: resolved.user.id, name: resolved.user.name } : null;
      },
      credentials: credentialChecker,
      startSession: (userId) => {
        const token = createUserSession(opts.db, userId);
        return serializeUserSessionCookie({
          value: token,
          path: basePath ?? "/",
          secure: opts.config.publicUrl?.startsWith("https://") ?? false,
        });
      },
    });
  }

  app.get("/health", healthHandler);
  if (basePath) {
    app.get(`${basePath}health`, healthHandler);
  }

  // Warm the update-check cache on boot so the first /health response after a
  // restart already includes `updateAvailable` (assuming the npm round-trip
  // completes before the dashboard's first poll, which it almost always does).
  // Fire-and-forget — boot does not wait on this.
  checkLatestVersionForServer();

  let resolveRuntimeStartup!: () => void;
  let rejectRuntimeStartup!: (error: unknown) => void;
  const runtimeStartup = new Promise<void>((resolve, reject) => {
    resolveRuntimeStartup = resolve;
    rejectRuntimeStartup = reject;
  });
  // Direct programmatic callers may choose not to await the production
  // readiness contract. Keep their process free of unhandled-rejection noise;
  // `waitForServerRuntimeStartup` still observes the original rejection.
  void runtimeStartup.catch(() => {});
  runtimeStartupByServer.set(app, runtimeStartup);

  // Background work must begin only after the listener is live. Fastify runs
  // onReady before attempting the bind, so starting there would still mutate
  // schedules/query baskets when listen() later fails with EADDRINUSE.
  let runtimeStartupSettled = false;
  app.addHook("onListen", () => {
    if (runtimeStartupSettled) return;
    try {
      scheduler.start();

      // A request can commit its queued row just before a process exits,
      // leaving no in-memory callback to claim it. Re-dispatch every queued
      // batch only after a successful bind; executeResearchRun's queued ->
      // running compare-and-set keeps this safe when a concurrent retry also
      // asks for execution.
      for (const run of opts.db.select({ id: researchRuns.id, projectId: researchRuns.projectId }).from(researchRuns).where(eq(researchRuns.status, ResearchRunStatuses.queued)).all()) {
        dispatchResearchRun(run.id, run.projectId);
      }
      runtimeStartupSettled = true;
      resolveRuntimeStartup();
    } catch (error) {
      runtimeStartupSettled = true;
      rejectRuntimeStartup(error);
    }
  });

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
