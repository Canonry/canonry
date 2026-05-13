<?php
/**
 * Plugin Name: Canonry Traffic Logger
 * Plugin URI:  https://canonry.dev
 * Description: Captures non-admin page-load events and exposes them via REST for the canonry traffic-ingestion pipeline. Hashes IPs per-site, no classification — server does that.
 * Version:     0.2.0
 * Requires PHP: 7.4
 * Author:      Canonry
 * License:     MIT
 *
 * This plugin produces rows matching the WordpressTrafficEventPayload contract
 * consumed by packages/integration-wordpress-traffic. It is intentionally minimal:
 * one writer (request hook), one reader (REST GET endpoint), one activation
 * (table + salt creation), one uninstall (drop both). Settings UI, retention,
 * salt rotation, and the test-button admin page are deliberately out of scope
 * for this slice — they ship in a wave-2 plugin slice.
 *
 * Security model:
 * - REST endpoint requires manage_options (chosen because traffic-log access is
 *   admin-equivalent: it exposes paths, UAs, referrers, and hashed IPs that
 *   together reveal site visitors. Editor/Author capabilities are insufficient).
 * - IPs are hashed with a per-site secret salt + sha256, only the first 12
 *   hex chars are stored — short enough to be infeasible to brute-force without
 *   the salt, long enough that collisions inside a single rolling window are
 *   negligible.
 */

declare(strict_types=1);

// Hard guard against direct loading outside WP / tests.
if (!defined('ABSPATH') && !defined('CANONRY_TRAFFIC_LOGGER_TEST_MODE')) {
    define('CANONRY_TRAFFIC_LOGGER_TEST_MODE', true);
}

require_once __DIR__ . '/includes/class-ip-hasher.php';
require_once __DIR__ . '/includes/class-recorder.php';
require_once __DIR__ . '/includes/class-rest.php';
require_once __DIR__ . '/includes/class-plugin.php';

// Real WP wires these via register_*_hook. Under the test shim these
// functions are no-ops that just stash the callback.
if (function_exists('register_activation_hook')) {
    register_activation_hook(__FILE__, ['\\Canonry\\TrafficLogger\\Plugin', 'activate']);
}
if (function_exists('register_uninstall_hook')) {
    register_uninstall_hook(__FILE__, ['\\Canonry\\TrafficLogger\\Plugin', 'uninstall']);
}

// Plugin bootstrap: register REST + request observer when WP fires `init`.
// In tests we exercise the classes directly so we don't depend on do_action().
if (function_exists('add_action')) {
    add_action('rest_api_init', ['\\Canonry\\TrafficLogger\\Rest', 'register']);
    add_action('shutdown', ['\\Canonry\\TrafficLogger\\Recorder', 'recordCurrentRequest']);
}
