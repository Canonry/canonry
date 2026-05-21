<?php
/**
 * Activation hook: creates the events table and records the schema version.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class ActivationTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
    }

    public function test_activation_records_schema_version(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        $version = get_option('canonry_traffic_logger_schema_version', null);
        $this->assertSame(\Canonry\TrafficLogger\Plugin::SCHEMA_VERSION, $version);

        // dbDelta is a no-op in the shim, so the table DDL is not asserted
        // directly; the ingestion and endpoint tests exercise table creation.
        $this->assertTrue(true);
    }

    public function test_activation_updates_schema_version_on_reactivation(): void {
        // An older install carries a stale schema version; re-activation must
        // bring it current (update_option, not a one-shot add_option).
        update_option('canonry_traffic_logger_schema_version', '1');

        \Canonry\TrafficLogger\Plugin::activate();

        $this->assertSame(
            \Canonry\TrafficLogger\Plugin::SCHEMA_VERSION,
            get_option('canonry_traffic_logger_schema_version', null)
        );
    }

    public function test_maybe_upgrade_reconciles_when_schema_version_stale(): void {
        // An in-place plugin update never fires the activation hook, so the
        // recorded version stays behind. maybeUpgrade() catches that.
        update_option('canonry_traffic_logger_schema_version', '1');

        \Canonry\TrafficLogger\Plugin::maybeUpgrade();

        $this->assertSame(
            \Canonry\TrafficLogger\Plugin::SCHEMA_VERSION,
            get_option('canonry_traffic_logger_schema_version', null)
        );
    }

    public function test_maybe_upgrade_runs_when_no_version_recorded(): void {
        // No schema-version option at all (files dropped in, never activated).
        \Canonry\TrafficLogger\Plugin::maybeUpgrade();

        $this->assertSame(
            \Canonry\TrafficLogger\Plugin::SCHEMA_VERSION,
            get_option('canonry_traffic_logger_schema_version', null)
        );
    }

    public function test_maybe_upgrade_is_noop_when_version_current(): void {
        update_option('canonry_traffic_logger_schema_version', \Canonry\TrafficLogger\Plugin::SCHEMA_VERSION);

        \Canonry\TrafficLogger\Plugin::maybeUpgrade();

        $this->assertSame(
            \Canonry\TrafficLogger\Plugin::SCHEMA_VERSION,
            get_option('canonry_traffic_logger_schema_version', null)
        );
    }

    public function test_main_plugin_file_wires_upgrade_check_to_admin_init(): void {
        canonry_traffic_logger_register_hooks();

        $wired = false;
        foreach ($GLOBALS['__wp_actions']['admin_init'] ?? [] as $entry) {
            $cb = $entry['cb'];
            if (is_array($cb) && ($cb[1] ?? '') === 'maybeUpgrade') {
                $wired = true;
            }
        }
        $this->assertTrue($wired, 'maybeUpgrade must be wired to admin_init');
    }
}
