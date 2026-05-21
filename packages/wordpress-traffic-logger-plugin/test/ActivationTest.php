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
}
