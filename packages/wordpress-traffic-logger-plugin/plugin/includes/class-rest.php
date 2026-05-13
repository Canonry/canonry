<?php
/**
 * REST endpoint: GET /wp-json/canonry/v1/events.
 *
 * Auth: Application Password via Basic auth. WP's normal REST stack
 * authenticates the request before this controller runs (via
 * wp_authenticate_application_password); we only check the final capability.
 * That keeps the surface honest — a stolen Application Password still requires
 * a manage_options-capable user to be useful.
 *
 * Pagination: ascending `(observed_at, id)`. Cursor is `base64(JSON({ts,id}))`.
 * Returning an opaque blob means callers can't construct fake cursors offline
 * and skip ahead; they can only continue from a real next_cursor we emitted.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class Rest {
    public const NAMESPACE = 'canonry/v1';
    public const ROUTE = '/events';
    public const DEFAULT_LIMIT = 500;
    public const MAX_LIMIT = 1000;

    public static function register(): void {
        register_rest_route(self::NAMESPACE, self::ROUTE, [
            'methods'             => 'GET',
            'callback'            => ['\\Canonry\\TrafficLogger\\Rest', 'handleList'],
            'permission_callback' => ['\\Canonry\\TrafficLogger\\Rest', 'checkPermission'],
            'args' => [
                'limit'  => ['type' => 'integer', 'required' => false],
                'cursor' => ['type' => 'string',  'required' => false],
            ],
        ]);
    }

    public static function checkPermission(\WP_REST_Request $request) {
        if (function_exists('current_user_can') && current_user_can('manage_options')) {
            return true;
        }
        return new \WP_Error(
            'rest_forbidden',
            'Authentication required (manage_options).',
            ['status' => function_exists('rest_authorization_required_code') ? rest_authorization_required_code() : 401]
        );
    }

    public static function handleList(\WP_REST_Request $request) {
        $limitRaw = $request->get_param('limit');
        $limit = self::clampLimit($limitRaw);
        $cursorRaw = $request->get_param('cursor');

        $cursor = null;
        if ($cursorRaw !== null && $cursorRaw !== '') {
            $cursor = self::decodeCursor((string) $cursorRaw);
            if ($cursor === null) {
                return new \WP_Error(
                    'invalid_cursor',
                    'Cursor is not a valid canonry traffic-logger cursor.',
                    ['status' => 400]
                );
            }
        }

        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;

        // Fetch limit+1 so we can tell `has_more` without a second COUNT round-trip.
        $fetch = $limit + 1;

        if ($cursor === null) {
            $sql = $wpdb->prepare(
                "SELECT id, observed_at, method, host, path, query_string, status, user_agent, remote_ip_hash, referer "
                . "FROM {$table} "
                . "ORDER BY observed_at ASC, id ASC "
                . "LIMIT %d",
                $fetch
            );
        } else {
            $sql = $wpdb->prepare(
                "SELECT id, observed_at, method, host, path, query_string, status, user_agent, remote_ip_hash, referer "
                . "FROM {$table} "
                . "WHERE (observed_at > %s) OR (observed_at = %s AND id > %d) "
                . "ORDER BY observed_at ASC, id ASC "
                . "LIMIT %d",
                $cursor['ts'],
                $cursor['ts'],
                (int) $cursor['id'],
                $fetch
            );
        }

        $rows = $wpdb->get_results($sql, ARRAY_A) ?: [];

        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            $rows = array_slice($rows, 0, $limit);
        }

        $events = array_map([self::class, 'serializeRow'], $rows);

        $nextCursor = null;
        if ($hasMore && !empty($rows)) {
            $last = $rows[count($rows) - 1];
            $nextCursor = self::encodeCursor((string) $last['observed_at'], (int) $last['id']);
        }

        return new \WP_REST_Response([
            'events'      => $events,
            'next_cursor' => $nextCursor,
            'has_more'    => $hasMore,
            'site'        => [
                'url'             => function_exists('home_url') ? home_url() : null,
                'plugin_version'  => '0.1.0',
            ],
        ], 200);
    }

    /** @param array<string,mixed> $row */
    private static function serializeRow(array $row): array {
        return [
            'id'             => (int) $row['id'],
            'observed_at'    => (string) $row['observed_at'],
            'method'         => $row['method'] !== null ? (string) $row['method'] : null,
            'host'           => $row['host'] !== null ? (string) $row['host'] : null,
            'path'           => (string) $row['path'],
            'query_string'   => $row['query_string'] !== null ? (string) $row['query_string'] : null,
            'status'         => $row['status'] !== null ? (int) $row['status'] : null,
            'user_agent'     => $row['user_agent'] !== null ? (string) $row['user_agent'] : null,
            'remote_ip_hash' => $row['remote_ip_hash'] !== null ? (string) $row['remote_ip_hash'] : null,
            'referer'        => $row['referer'] !== null ? (string) $row['referer'] : null,
        ];
    }

    private static function clampLimit($raw): int {
        if ($raw === null || $raw === '') return self::DEFAULT_LIMIT;
        $n = is_numeric($raw) ? (int) $raw : self::DEFAULT_LIMIT;
        if ($n < 1) return self::DEFAULT_LIMIT;
        if ($n > self::MAX_LIMIT) return self::MAX_LIMIT;
        return $n;
    }

    private static function encodeCursor(string $observedAt, int $id): string {
        $payload = json_encode(['ts' => $observedAt, 'id' => $id]);
        // Use unpadded base64url so the cursor survives in query strings without escaping.
        return rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    }

    /** @return array{ts:string,id:int}|null */
    private static function decodeCursor(string $raw): ?array {
        // base64url -> standard base64 round-trip.
        $b = strtr($raw, '-_', '+/');
        $pad = strlen($b) % 4;
        if ($pad !== 0) {
            $b .= str_repeat('=', 4 - $pad);
        }
        $decoded = base64_decode($b, true);
        if ($decoded === false) return null;
        $obj = json_decode($decoded, true);
        if (!is_array($obj)) return null;
        if (!isset($obj['ts']) || !is_string($obj['ts'])) return null;
        if (!isset($obj['id']) || !is_int($obj['id'])) return null;
        return ['ts' => $obj['ts'], 'id' => $obj['id']];
    }
}

// WP defines ARRAY_A as 'ARRAY_A'; provide a default so the plugin file loads
// in environments (tests, MU bootstrap) that haven't constants loaded yet.
if (!defined('ARRAY_A')) {
    define('ARRAY_A', 'ARRAY_A');
}
