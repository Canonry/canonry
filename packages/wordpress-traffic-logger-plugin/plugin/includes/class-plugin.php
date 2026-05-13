<?php
/**
 * Plugin lifecycle: activate / uninstall + retention auto-prune.
 *
 * Deactivate is intentionally absent for the table: deactivating should not
 * destroy data, the operator may re-activate later and expect their event
 * log to still be present. We *do* unschedule the cron event on uninstall
 * so a removed plugin does not leave a phantom hook behind.
 *
 * Retention auto-prune: WP-Cron runs `canonry_traffic_logger_prune` once a
 * day, which deletes events older than the configured retention window
 * (`canonry_traffic_logger_retention_days`, default 90, clamped to 7..365).
 * The cron event is registered at activation and unscheduled at uninstall.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class Plugin {
    public const SCHEMA_VERSION = '1';
    public const SCHEMA_VERSION_OPTION = 'canonry_traffic_logger_schema_version';

    public const RETENTION_OPTION = 'canonry_traffic_logger_retention_days';
    public const RETENTION_DEFAULT = 90;
    public const RETENTION_MIN = 7;
    public const RETENTION_MAX = 365;

    public const PRUNE_HOOK = 'canonry_traffic_logger_prune';

    public static function activate(): void {
        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $charsetCollate = $wpdb->get_charset_collate();

        // dbDelta requires the SQL to follow its peculiar formatting rules:
        // - PRIMARY KEY rather than `PRIMARY KEY (...)` inline on the column
        // - two spaces between `PRIMARY KEY` and the column list
        // - one column per line
        $sql = "CREATE TABLE {$table} (\n"
            . "  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,\n"
            . "  observed_at varchar(40) NOT NULL,\n"
            . "  method varchar(10) NULL,\n"
            . "  host varchar(255) NULL,\n"
            . "  path varchar(2048) NOT NULL,\n"
            . "  query_string text NULL,\n"
            . "  status smallint unsigned NULL,\n"
            . "  user_agent varchar(1024) NULL,\n"
            . "  remote_ip_hash varchar(24) NULL,\n"
            . "  referer varchar(2048) NULL,\n"
            . "  PRIMARY KEY  (id),\n"
            . "  KEY observed_at_id (observed_at, id)\n"
            . ") {$charsetCollate};\n";

        // dbDelta lives in wp-admin/includes/upgrade.php in real WP. The test
        // shim provides a no-op stand-in.
        if (file_exists(ABSPATH . 'wp-admin/includes/upgrade.php')) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        }
        if (function_exists('dbDelta')) {
            dbDelta($sql);
        }

        // Create salt option only if it does not already exist (preserve on
        // re-activation so existing hashes remain comparable).
        if (get_option(Recorder::SALT_OPTION, null) === null) {
            $salt = self::generateSalt();
            add_option(Recorder::SALT_OPTION, $salt);
        }
        if (get_option(self::SCHEMA_VERSION_OPTION, null) === null) {
            add_option(self::SCHEMA_VERSION_OPTION, self::SCHEMA_VERSION);
        }

        // Schedule daily prune only if not already scheduled (re-activation
        // should be idempotent and not push the next-fire timestamp forward).
        if (function_exists('wp_next_scheduled') && function_exists('wp_schedule_event')) {
            if (!wp_next_scheduled(self::PRUNE_HOOK)) {
                wp_schedule_event(time() + DAY_IN_SECONDS_FALLBACK, 'daily', self::PRUNE_HOOK);
            }
        }
    }

    public static function uninstall(): void {
        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $wpdb->query("DROP TABLE IF EXISTS {$table}");

        delete_option(Recorder::SALT_OPTION);
        delete_option(self::SCHEMA_VERSION_OPTION);
        delete_option(self::RETENTION_OPTION);

        if (function_exists('wp_clear_scheduled_hook')) {
            wp_clear_scheduled_hook(self::PRUNE_HOOK);
        }
    }

    /**
     * Resolve the configured retention window, clamping any out-of-range
     * value to [RETENTION_MIN, RETENTION_MAX]. Non-numeric / unset values
     * fall back to RETENTION_DEFAULT.
     */
    public static function retentionDays(): int {
        $raw = get_option(self::RETENTION_OPTION, null);
        if ($raw === null || $raw === '' || !is_numeric($raw)) {
            return self::RETENTION_DEFAULT;
        }
        $n = (int) $raw;
        if ($n < self::RETENTION_MIN) return self::RETENTION_MIN;
        if ($n > self::RETENTION_MAX) return self::RETENTION_MAX;
        return $n;
    }

    /**
     * WP-Cron callback. Delete events older than the configured retention
     * window. Stored timestamps are ISO 8601 UTC (`observed_at`), which
     * sort lexicographically against any same-format cutoff string — so
     * a simple `observed_at < <iso-cutoff>` comparison is sound.
     */
    public static function pruneExpired(): void {
        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $days = self::retentionDays();

        try {
            $cutoff = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
                ->modify('-' . $days . ' days')
                ->format('Y-m-d\\TH:i:s.v\\Z');
        } catch (\Throwable $e) {
            return; // If we can't compute a cutoff, do nothing rather than wipe.
        }

        $sql = $wpdb->prepare("DELETE FROM {$table} WHERE observed_at < %s", $cutoff);
        $wpdb->query($sql);
    }

    private static function generateSalt(): string {
        if (function_exists('wp_generate_password')) {
            return wp_generate_password(64, true);
        }
        return bin2hex(random_bytes(32));
    }
}

// WP defines DAY_IN_SECONDS in wp-includes/default-constants.php; provide a
// fallback so the class loads in test/MU bootstrap environments that haven't
// loaded constants yet.
if (!defined('Canonry\\TrafficLogger\\DAY_IN_SECONDS_FALLBACK')) {
    define('Canonry\\TrafficLogger\\DAY_IN_SECONDS_FALLBACK', defined('DAY_IN_SECONDS') ? DAY_IN_SECONDS : 86400);
}
