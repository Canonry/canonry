<?php
/**
 * Request hook. For every non-admin, non-AJAX page-load, write one event row.
 *
 * `record()` is intentionally pure-ish: it takes a `$server`-shaped array and
 * a status code (caller's responsibility — WP fires this in `shutdown` where
 * `http_response_code()` is reliable). Tests call it with a synthetic array;
 * `recordCurrentRequest()` is the WP-wired entry point that pulls `$_SERVER`
 * and the live response code.
 *
 * We never sanitize away the path query string here — we split it into
 * `path` and `query_string` because the TS adapter's normalizer expects them
 * separately.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class Recorder {
    public const TABLE = 'canonry_traffic_events';

    /** @param array<string, mixed> $server */
    public static function record(array $server, ?int $status): void {
        if (!self::shouldRecord($server)) return;

        $method = self::stringOrNull($server['REQUEST_METHOD'] ?? null);
        $host = self::stringOrNull($server['HTTP_HOST'] ?? null);
        $uri = self::stringOrNull($server['REQUEST_URI'] ?? null);
        if ($uri === null) return; // Can't record without a URI.
        [$path, $queryString] = self::splitUri($uri);

        $userAgent = self::stringOrNull($server['HTTP_USER_AGENT'] ?? null);
        $referer = self::stringOrNull($server['HTTP_REFERER'] ?? null);
        // Resolve the real client IP. Forwarded headers are consulted only
        // when the operator has marked the site as behind a trusted proxy
        // (see ClientIp::resolve); otherwise REMOTE_ADDR is used as-is.
        $remoteIp = ClientIp::resolve($server, Plugin::trustProxy());

        $observedAt = self::nowIsoUtc();

        global $wpdb;
        $table = $wpdb->prefix . self::TABLE;
        $wpdb->insert(
            $table,
            [
                'observed_at'    => $observedAt,
                'method'         => $method,
                'host'           => $host,
                'path'           => $path,
                'query_string'   => $queryString,
                'status'         => $status,
                'user_agent'     => $userAgent,
                'remote_ip'      => $remoteIp,
                'referer'        => $referer,
            ],
            // Format hints for wpdb->insert (real wpdb uses these to prepare; the test mock ignores them).
            ['%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s']
        );
    }

    public static function recordCurrentRequest(): void {
        // WP entry point. Pull from supersgloballs and live status. We are
        // intentionally lenient about wp_unslash here because most $_SERVER
        // values are never slashed, but we keep the call for the headers WP
        // may have routed through itself.
        if (!isset($GLOBALS['__wp_recorder_test_disabled']) || !$GLOBALS['__wp_recorder_test_disabled']) {
            $server = function_exists('wp_unslash') ? wp_unslash($_SERVER) : $_SERVER;
            $status = function_exists('http_response_code') ? (int) http_response_code() : null;
            self::record(is_array($server) ? $server : [], $status);
        }
    }

    /** @param array<string, mixed> $server */
    private static function shouldRecord(array $server): bool {
        $uri = (string) ($server['REQUEST_URI'] ?? '');
        if ($uri === '') return false;
        if (strpos($uri, '/wp-admin/') !== false) return false;
        if (strpos($uri, '/wp-json/canonry/') !== false) return false; // Don't log our own endpoint.

        // WP defines DOING_AJAX during admin-ajax handling. Skip if set.
        if (defined('DOING_AJAX') && DOING_AJAX) return false;

        // Skip non-GET. AI crawlers and human clicks from AI referrers are
        // always GET; POSTs are comment submissions, logins, admin saves —
        // noise the server-side classifier discards anyway.
        $method = strtoupper((string) ($server['REQUEST_METHOD'] ?? ''));
        if ($method !== '' && $method !== 'GET') return false;

        return true;
    }

    /** @return array{0:string, 1:?string} */
    private static function splitUri(string $uri): array {
        $qPos = strpos($uri, '?');
        if ($qPos === false) {
            return [$uri, null];
        }
        $path = substr($uri, 0, $qPos);
        $q = substr($uri, $qPos + 1);
        return [$path, $q === '' ? null : $q];
    }

    private static function stringOrNull($value): ?string {
        if ($value === null) return null;
        if (!is_scalar($value)) return null;
        $s = (string) $value;
        return $s === '' ? null : $s;
    }

    private static function nowIsoUtc(): string {
        // Microsecond-precision ISO 8601 in UTC. Real WP has `current_time('mysql', true)`
        // which is "Y-m-d H:i:s"; we want ISO 8601 because the adapter normalizes against it.
        // gmdate('c') gives ISO 8601 in UTC; we add milliseconds for ordering granularity.
        try {
            $now = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\\TH:i:s.v\\Z');
            return $now;
        } catch (\Throwable $e) {
            return gmdate('Y-m-d\\TH:i:s\\Z');
        }
    }
}
