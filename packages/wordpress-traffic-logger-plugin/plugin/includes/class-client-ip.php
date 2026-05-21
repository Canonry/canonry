<?php
/**
 * Resolve the real client IP for a request. Pure function, no WP
 * dependency, so it is trivially testable from a synthetic `$server`
 * array, mirroring `Recorder::record()`.
 *
 * REMOTE_ADDR is the only address the web server observes directly. When
 * the site sits behind a CDN or reverse proxy, REMOTE_ADDR is the proxy's
 * edge IP and the real visitor is carried in a forwarded header. Those
 * headers are client-settable, so they are consulted ONLY when the
 * operator has marked the site as proxied (the `trustProxy` flag, surfaced
 * as a settings-page toggle). On a non-proxied site, trusting them would
 * let a visitor forge their source IP.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class ClientIp {
    /**
     * @param array<string, mixed> $server     A `$_SERVER`-shaped array.
     * @param bool                 $trustProxy True when the site is behind a trusted CDN/proxy.
     */
    public static function resolve(array $server, bool $trustProxy): ?string {
        if ($trustProxy) {
            // Single-IP CDN headers first: each carries exactly the
            // originating client, set by the edge, not an appendable list.
            foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_TRUE_CLIENT_IP', 'HTTP_X_REAL_IP'] as $header) {
                $ip = self::validIp($server[$header] ?? null);
                if ($ip !== null) return $ip;
            }
            // X-Forwarded-For is "client, proxy1, proxy2, ...". A visitor
            // can PREPEND a forged entry, but cannot forge the entry the
            // trusted proxy itself appends, which sits to the right. Walk
            // right-to-left and take the first valid public IP: the address
            // the trusted proxy actually saw the connection from.
            $forwarded = $server['HTTP_X_FORWARDED_FOR'] ?? null;
            if (is_string($forwarded) && $forwarded !== '') {
                $rightmostValid = null;
                foreach (array_reverse(explode(',', $forwarded)) as $part) {
                    $ip = self::validIp($part);
                    if ($ip === null) continue;
                    if ($rightmostValid === null) $rightmostValid = $ip;
                    if (self::isPublic($ip)) return $ip;
                }
                if ($rightmostValid !== null) return $rightmostValid;
            }
        }
        return self::validIp($server['REMOTE_ADDR'] ?? null);
    }

    /** Trim and syntactically validate an IP; null for empty or malformed input. */
    private static function validIp($value): ?string {
        if (!is_scalar($value)) return null;
        $trimmed = trim((string) $value);
        if ($trimmed === '') return null;
        return filter_var($trimmed, FILTER_VALIDATE_IP) !== false ? $trimmed : null;
    }

    /** True when the IP is a routable public address (not private or reserved). */
    private static function isPublic(string $ip): bool {
        return filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
        ) !== false;
    }
}
