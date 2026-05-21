<?php
/**
 * Plugin Name: Canonry Traffic Logger
 * Plugin URI:  https://canonry.ai
 * Description: Captures non-admin page-load events and exposes them via REST for the canonry traffic-ingestion pipeline. No classification; the server does that.
 * Version:     0.3.0
 * Requires PHP: 7.4
 * Author:      Canonry
 * License:     MIT
 *
 * This plugin produces rows matching the WordpressTrafficEventPayload contract
 * consumed by packages/integration-wordpress-traffic. It is intentionally minimal:
 * one writer (request hook), one reader (REST GET endpoint), one activation
 * (table creation), one uninstall (drop it). Retention auto-prune and a minimal
 * settings page ship alongside.
 *
 * Security model:
 * - REST endpoint requires manage_options (chosen because traffic-log access is
 *   admin-equivalent: it exposes paths, UAs, referrers, and client IPs that
 *   together reveal site visitors. Editor/Author capabilities are insufficient).
 * - The real client IP is recorded so the canonry server can verify bot claims
 *   against published operator IP ranges, matching the Cloud Run and Vercel
 *   traffic loggers. Forwarded headers (X-Forwarded-For, CF-Connecting-IP) are
 *   honored only when the operator marks the site as behind a trusted proxy;
 *   otherwise REMOTE_ADDR is used so a visitor cannot forge their IP.
 */

declare(strict_types=1);

// Hard guard against direct loading outside WP / tests.
if (!defined('ABSPATH') && !defined('CANONRY_TRAFFIC_LOGGER_TEST_MODE')) {
    define('CANONRY_TRAFFIC_LOGGER_TEST_MODE', true);
}

require_once __DIR__ . '/includes/class-client-ip.php';
require_once __DIR__ . '/includes/class-recorder.php';
require_once __DIR__ . '/includes/class-rest.php';
require_once __DIR__ . '/includes/class-plugin.php';
require_once __DIR__ . '/includes/class-settings-page.php';

// Real WP wires these via register_*_hook. Under the test shim these
// functions are no-ops that just stash the callback.
if (function_exists('register_activation_hook')) {
    register_activation_hook(__FILE__, ['\\Canonry\\TrafficLogger\\Plugin', 'activate']);
}
if (function_exists('register_uninstall_hook')) {
    register_uninstall_hook(__FILE__, ['\\Canonry\\TrafficLogger\\Plugin', 'uninstall']);
}

/**
 * Bootstrap helper: registers every action this plugin owns. Called once
 * at file-load (when add_action exists) and re-invoked by the test harness
 * after wpshim_reset() to restore the action wiring without re-including
 * the file (require_once already loaded it).
 */
function canonry_traffic_logger_register_hooks(): void {
    if (!function_exists('add_action')) return;
    add_action('rest_api_init', ['\\Canonry\\TrafficLogger\\Rest', 'register']);
    add_action('shutdown', ['\\Canonry\\TrafficLogger\\Recorder', 'recordCurrentRequest']);

    // Retention prune callback wired to the scheduled WP-Cron event.
    add_action(
        \Canonry\TrafficLogger\Plugin::PRUNE_HOOK,
        ['\\Canonry\\TrafficLogger\\Plugin', 'pruneExpired']
    );

    // Admin surface (settings page + setting registration). These hooks
    // only fire inside wp-admin; they are no-ops on front-end requests
    // so the shutdown-hook recorder remains unaffected.
    add_action('admin_menu', ['\\Canonry\\TrafficLogger\\SettingsPage', 'registerMenu']);
    add_action('admin_init', ['\\Canonry\\TrafficLogger\\SettingsPage', 'registerSetting']);

    // Schema upgrade check. A plugin updated in place never fires the
    // activation hook; this catches a stale schema on the next admin load.
    add_action('admin_init', ['\\Canonry\\TrafficLogger\\Plugin', 'maybeUpgrade']);
}

// Plugin bootstrap: register REST + request observer when WP fires `init`.
// In tests we exercise the classes directly so we don't depend on do_action().
canonry_traffic_logger_register_hooks();
