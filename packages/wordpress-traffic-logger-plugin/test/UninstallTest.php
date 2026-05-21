<?php
/**
 * Uninstall drops the events table and clears every plugin option,
 * including the legacy pre-0.3.0 IP-hash salt.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class UninstallTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
    }

    public function test_uninstall_drops_table_and_options(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        // Operator-configurable options, plus a legacy salt a pre-0.3.0
        // install would have left behind, so we can witness every one go.
        update_option('canonry_traffic_logger_retention_days', 30);
        update_option('canonry_traffic_logger_trust_proxy', '1');
        update_option('canonry_traffic_logger_ip_salt', 'legacy-salt-value');

        // Seed a row so we can witness the table drop.
        \Canonry\TrafficLogger\Recorder::record([
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/x',
            'HTTP_USER_AGENT'=> 'GPTBot/1.2',
            'REMOTE_ADDR'    => '203.0.113.4',
        ], 200);

        global $wpdb;
        $table = $wpdb->prefix . 'canonry_traffic_events';
        $this->assertCount(1, $wpdb->rows[$table] ?? []);
        $this->assertNotNull(get_option('canonry_traffic_logger_schema_version', null));

        \Canonry\TrafficLogger\Plugin::uninstall();

        $this->assertTrue(!isset($wpdb->rows[$table]), 'table rows must be dropped');
        $this->assertSame(false, get_option('canonry_traffic_logger_schema_version', false));
        $this->assertSame(false, get_option('canonry_traffic_logger_retention_days', false));
        $this->assertSame(false, get_option('canonry_traffic_logger_trust_proxy', false));
        $this->assertSame(false, get_option('canonry_traffic_logger_ip_salt', false));
    }
}
