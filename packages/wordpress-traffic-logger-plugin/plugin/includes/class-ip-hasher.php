<?php
/**
 * Per-site IP hashing. Pure function — no WP dependency — so it's trivially
 * testable and reusable from CLI scripts (e.g. backfill jobs) if we ever
 * need them.
 *
 * Hash = first 12 hex chars of sha256($ip . $salt). 48 bits of entropy is
 * enough to keep unique-visitor counting useful inside a single salt window
 * while making rainbow-tabling the original IP infeasible without the salt.
 *
 * The salt is generated once per site at activation (wp_generate_password or
 * random_bytes) and never leaves the WP options table.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class IpHasher {
    public const HASH_LEN_HEX = 12;

    public static function hash(?string $ip, string $salt): ?string {
        if ($ip === null) return null;
        $trimmed = trim($ip);
        if ($trimmed === '') return null;
        return substr(hash('sha256', $trimmed . $salt), 0, self::HASH_LEN_HEX);
    }
}
