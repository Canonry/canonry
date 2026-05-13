<?php
/**
 * Plugin lifecycle: activate / uninstall. Deactivate is intentionally absent
 * — deactivating should not destroy data; the operator may re-activate later
 * and expect their event log to still be present.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class Plugin {
    public const SCHEMA_VERSION = '1';
    public const SCHEMA_VERSION_OPTION = 'canonry_traffic_logger_schema_version';

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
    }

    public static function uninstall(): void {
        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $wpdb->query("DROP TABLE IF EXISTS {$table}");

        delete_option(Recorder::SALT_OPTION);
        delete_option(self::SCHEMA_VERSION_OPTION);
    }

    private static function generateSalt(): string {
        if (function_exists('wp_generate_password')) {
            return wp_generate_password(64, true);
        }
        return bin2hex(random_bytes(32));
    }
}
