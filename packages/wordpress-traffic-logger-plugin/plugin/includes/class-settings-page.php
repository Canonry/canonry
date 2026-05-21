<?php
/**
 * Settings page at `Settings → Canonry Traffic Logger`.
 *
 * Minimal by design: a retention-days knob and a trusted-proxy toggle,
 * plus read-only operator visibility into how many events live in the
 * table and how old the oldest row is. Everything else (test-endpoint
 * button, multisite admin) is intentionally out of scope and deferred.
 *
 * Capability gate: `manage_options`. Same capability that gates the REST
 * endpoint — a non-admin must never be able to see or change the
 * traffic-logger configuration.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class SettingsPage {
    public const MENU_SLUG = 'canonry-traffic-logger';
    public const OPTION_GROUP = 'canonry_traffic_logger';
    public const SECTION_ID = 'canonry_traffic_logger_main';
    public const SECTION_ID_NETWORK = 'canonry_traffic_logger_network';

    public static function registerMenu(): void {
        if (!function_exists('add_options_page')) return;
        add_options_page(
            'Canonry Traffic Logger',
            'Canonry Traffic Logger',
            'manage_options',
            self::MENU_SLUG,
            [self::class, 'render']
        );
    }

    public static function registerSetting(): void {
        if (!function_exists('register_setting')) return;
        register_setting(self::OPTION_GROUP, Plugin::RETENTION_OPTION, [
            'type'              => 'integer',
            'description'       => 'Days of event history to retain before auto-prune.',
            'sanitize_callback' => [self::class, 'sanitizeRetention'],
            'default'           => Plugin::RETENTION_DEFAULT,
        ]);

        if (function_exists('add_settings_section')) {
            add_settings_section(
                self::SECTION_ID,
                'Retention',
                [self::class, 'renderSectionIntro'],
                self::MENU_SLUG
            );
        }
        if (function_exists('add_settings_field')) {
            add_settings_field(
                Plugin::RETENTION_OPTION,
                'Days of event history',
                [self::class, 'renderRetentionField'],
                self::MENU_SLUG,
                self::SECTION_ID
            );
        }

        register_setting(self::OPTION_GROUP, Plugin::TRUST_PROXY_OPTION, [
            'type'              => 'boolean',
            'description'       => 'Whether the site is behind a trusted proxy or CDN.',
            'sanitize_callback' => [self::class, 'sanitizeTrustProxy'],
            'default'           => '',
        ]);

        if (function_exists('add_settings_section')) {
            add_settings_section(
                self::SECTION_ID_NETWORK,
                'Client IP',
                [self::class, 'renderNetworkSectionIntro'],
                self::MENU_SLUG
            );
        }
        if (function_exists('add_settings_field')) {
            add_settings_field(
                Plugin::TRUST_PROXY_OPTION,
                'Behind a proxy or CDN',
                [self::class, 'renderTrustProxyField'],
                self::MENU_SLUG,
                self::SECTION_ID_NETWORK
            );
        }
    }

    /**
     * Clamp the retention option to a sane range. Values below the minimum
     * snap up; values above the maximum snap down; non-numeric / empty
     * input falls back to the default. (We chose clamp over reject to
     * mirror the runtime `Plugin::retentionDays()` behavior — an out-of-
     * range value that somehow ends up persisted must produce a sane
     * effective window either way.)
     */
    public static function sanitizeRetention($value): int {
        if ($value === null || $value === '' || !is_numeric($value)) {
            return Plugin::RETENTION_DEFAULT;
        }
        $n = (int) $value;
        if ($n < Plugin::RETENTION_MIN) return Plugin::RETENTION_MIN;
        if ($n > Plugin::RETENTION_MAX) return Plugin::RETENTION_MAX;
        return $n;
    }

    public static function renderSectionIntro(): void {
        echo '<p>';
        echo esc_html(
            'Events older than this window are deleted once per day by a WP-Cron job. '
            . 'Range: ' . Plugin::RETENTION_MIN . '–' . Plugin::RETENTION_MAX . ' days.'
        );
        echo '</p>';
    }

    public static function renderRetentionField(): void {
        $current = Plugin::retentionDays();
        printf(
            '<input type="number" name="%s" value="%d" min="%d" max="%d" step="1" /> days',
            esc_attr(Plugin::RETENTION_OPTION),
            (int) $current,
            (int) Plugin::RETENTION_MIN,
            (int) Plugin::RETENTION_MAX
        );
    }

    /**
     * Normalize the trusted-proxy checkbox to a stored '1' / '' string. A
     * checked checkbox posts '1' (or 'on'); an unchecked one posts nothing.
     */
    public static function sanitizeTrustProxy($value): string {
        if ($value === '1' || $value === 1 || $value === true || $value === 'on') {
            return '1';
        }
        return '';
    }

    public static function renderNetworkSectionIntro(): void {
        echo '<p>';
        echo esc_html(
            'Enable this only if the site sits behind Cloudflare, a load balancer, '
            . 'or another reverse proxy. When on, the real visitor IP is read from '
            . 'forwarded headers; when off, the direct connection address is used.'
        );
        echo '</p>';
    }

    public static function renderTrustProxyField(): void {
        printf(
            '<label><input type="checkbox" name="%s" value="1"%s /> %s</label>',
            esc_attr(Plugin::TRUST_PROXY_OPTION),
            Plugin::trustProxy() ? ' checked' : '',
            esc_html('This site is behind a CDN or reverse proxy')
        );
    }

    public static function render(): void {
        if (!function_exists('current_user_can') || !current_user_can('manage_options')) {
            if (function_exists('wp_die')) {
                wp_die('You need the manage_options capability to view this page.');
            }
            throw new \RuntimeException('manage_options capability required');
        }

        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $count  = (int) ($wpdb->get_var("SELECT COUNT(*) FROM {$table}") ?? 0);
        $oldest = $wpdb->get_var("SELECT MIN(observed_at) FROM {$table}");

        $retention = Plugin::retentionDays();

        echo '<div class="wrap">';
        echo '<h1>' . esc_html('Canonry Traffic Logger') . '</h1>';

        echo '<form method="post" action="options.php">';
        if (function_exists('settings_fields')) {
            settings_fields(self::OPTION_GROUP);
        }
        if (function_exists('do_settings_sections')) {
            do_settings_sections(self::MENU_SLUG);
        }
        // Always render the retention input so non-Settings-API environments
        // (and our test harness) can read the current value back.
        printf(
            '<input type="number" name="%s" value="%d" min="%d" max="%d" step="1" />',
            esc_attr(Plugin::RETENTION_OPTION),
            (int) $retention,
            (int) Plugin::RETENTION_MIN,
            (int) Plugin::RETENTION_MAX
        );
        if (function_exists('submit_button')) {
            submit_button();
        }
        echo '</form>';

        echo '<h2>' . esc_html('Status') . '</h2>';
        echo '<table class="widefat striped">';
        echo '<tbody>';
        echo '<tr><th scope="row">' . esc_html('Events stored') . '</th>'
            . '<td>' . esc_html((string) $count) . '</td></tr>';
        echo '<tr><th scope="row">' . esc_html('Oldest event') . '</th>'
            . '<td>' . esc_html($oldest !== null ? (string) $oldest : 'none') . '</td></tr>';
        echo '<tr><th scope="row">' . esc_html('Retention window') . '</th>'
            . '<td>' . esc_html($retention . ' days') . '</td></tr>';
        echo '</tbody>';
        echo '</table>';

        echo '</div>';
    }
}
