<?php
/**
 * The events REST endpoint signals fronting page caches (LiteSpeed, W3 Total
 * Cache, and similar) not to cache its response, so the authenticated,
 * per-request traffic feed the canonry sync reads is never served stale from
 * a frozen copy.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class CacheControlTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
    }

    public function test_events_endpoint_fires_litespeed_nocache_action(): void {
        $reason = null;
        add_action('litespeed_control_set_nocache', function ($r = '') use (&$reason) {
            $reason = $r;
        });

        $response = \Canonry\TrafficLogger\Rest::handleList(new \WP_REST_Request('GET'));

        $this->assertSame(200, $response->get_status());
        $this->assertNotNull($reason, 'litespeed_control_set_nocache must fire for the events endpoint');
        $this->assertStringContainsString('canonry', (string) $reason);
    }

    public function test_events_endpoint_defines_donotcachepage(): void {
        \Canonry\TrafficLogger\Rest::handleList(new \WP_REST_Request('GET'));

        $this->assertTrue(defined('DONOTCACHEPAGE'));
        $this->assertSame(true, constant('DONOTCACHEPAGE'));
    }
}
