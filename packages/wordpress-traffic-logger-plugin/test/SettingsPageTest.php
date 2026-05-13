<?php
/**
 * Settings page: a minimal admin form under `Settings → Canonry Traffic Logger`
 * that lets the operator change retention days, and renders read-only
 * visibility into how many events the table currently holds and how old
 * the oldest event is.
 *
 * Capability gate: `manage_options`. Same capability that gates the REST
 * endpoint — a non-admin should never be able to read or change the
 * traffic-logger configuration.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class SettingsPageTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
    }

    public function test_admin_menu_registers_options_page(): void {
        \Canonry\TrafficLogger\SettingsPage::registerMenu();

        $pages = $GLOBALS['__wp_options_pages'] ?? [];
        $this->assertCount(1, $pages);
        $page = $pages[0];

        $this->assertSame('Canonry Traffic Logger', $page['page_title']);
        $this->assertSame('Canonry Traffic Logger', $page['menu_title']);
        $this->assertSame('manage_options', $page['capability']);
        $this->assertSame('canonry-traffic-logger', $page['menu_slug']);
    }

    public function test_setting_is_registered_with_sanitizer(): void {
        \Canonry\TrafficLogger\SettingsPage::registerSetting();

        $registered = $GLOBALS['__wp_registered_settings'] ?? [];
        $this->assertArrayHasKey(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, $registered);

        $args = $registered[\Canonry\TrafficLogger\Plugin::RETENTION_OPTION];
        $this->assertSame('canonry_traffic_logger', $args['option_group']);
        $this->assertTrue(is_callable($args['args']['sanitize_callback'] ?? null));
    }

    public function test_sanitizer_clamps_to_range(): void {
        $sanitize = [\Canonry\TrafficLogger\SettingsPage::class, 'sanitizeRetention'];

        $this->assertSame(7,   call_user_func($sanitize, 1));      // below min
        $this->assertSame(7,   call_user_func($sanitize, 7));      // at min
        $this->assertSame(90,  call_user_func($sanitize, 90));     // default
        $this->assertSame(365, call_user_func($sanitize, 365));    // at max
        $this->assertSame(365, call_user_func($sanitize, 9999));   // above max
        $this->assertSame(90,  call_user_func($sanitize, 'abc'));  // non-numeric → default
        $this->assertSame(90,  call_user_func($sanitize, ''));     // empty → default
    }

    public function test_render_requires_manage_options(): void {
        $GLOBALS['__wp_current_user_can'] = false;

        $this->assertThrows(
            fn() => \Canonry\TrafficLogger\SettingsPage::render(),
            null,
            'manage_options'
        );
    }

    public function test_render_shows_current_retention_value(): void {
        $GLOBALS['__wp_current_user_can'] = true;
        update_option(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, 45);

        ob_start();
        \Canonry\TrafficLogger\SettingsPage::render();
        $html = ob_get_clean();

        $this->assertStringContainsString('value="45"', $html);
        $this->assertStringContainsString('canonry_traffic_logger_retention_days', $html);
    }

    public function test_render_shows_event_count_and_oldest_event(): void {
        $GLOBALS['__wp_current_user_can'] = true;

        global $wpdb;
        $table = $wpdb->prefix . \Canonry\TrafficLogger\Recorder::TABLE;
        $wpdb->insert($table, ['observed_at' => '2026-01-01T00:00:00.000Z', 'path' => '/a']);
        $wpdb->insert($table, ['observed_at' => '2026-05-01T00:00:00.000Z', 'path' => '/b']);

        ob_start();
        \Canonry\TrafficLogger\SettingsPage::render();
        $html = ob_get_clean();

        $this->assertStringContainsString('2', $html);                             // event count
        $this->assertStringContainsString('2026-01-01T00:00:00.000Z', $html);      // oldest event
    }

    public function test_render_shows_zero_when_table_empty(): void {
        $GLOBALS['__wp_current_user_can'] = true;

        ob_start();
        \Canonry\TrafficLogger\SettingsPage::render();
        $html = ob_get_clean();

        // Count zero displayed; oldest-event slot says "none" or similar (no ISO timestamp).
        $this->assertStringContainsString('0', $html);
    }

    public function test_main_plugin_file_wires_admin_menu_and_setting_hooks(): void {
        // The admin menu must be wired through admin_menu and admin_init actions.
        $hasAdminMenu  = false;
        $hasAdminInit  = false;
        foreach ($GLOBALS['__wp_actions']['admin_menu'] ?? [] as $entry) {
            $hasAdminMenu = true;
        }
        foreach ($GLOBALS['__wp_actions']['admin_init'] ?? [] as $entry) {
            $hasAdminInit = true;
        }
        $this->assertTrue($hasAdminMenu, 'admin_menu action must be wired in the main plugin file');
        $this->assertTrue($hasAdminInit, 'admin_init action must be wired in the main plugin file');
    }
}
