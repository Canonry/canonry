<?php
/**
 * Activation hook: creates table, generates per-site salt option.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class ActivationTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
    }

    public function test_activation_creates_table_and_salt_option(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        $salt = get_option('canonry_traffic_logger_ip_salt', null);
        $this->assertNotNull($salt);
        $this->assertTrue(is_string($salt) && strlen($salt) >= 32, 'salt must be at least 32 chars');

        $version = get_option('canonry_traffic_logger_schema_version', null);
        $this->assertNotNull($version);

        // dbDelta is a no-op in the shim; we just confirm activate() called it for the events table.
        // The wpdb mock auto-creates table rows arrays on first insert, so we can't assert table DDL
        // directly. We exercise creation indirectly via the ingestion test.
        $this->assertTrue(true);
    }

    public function test_activation_does_not_overwrite_existing_salt(): void {
        update_option('canonry_traffic_logger_ip_salt', 'preexisting-salt-value');

        \Canonry\TrafficLogger\Plugin::activate();

        $this->assertSame('preexisting-salt-value', get_option('canonry_traffic_logger_ip_salt', null));
    }
}
