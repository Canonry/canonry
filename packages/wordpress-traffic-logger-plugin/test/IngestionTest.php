<?php
/**
 * Request hook captures non-admin, non-AJAX page-loads and writes one event row
 * matching `WordpressTrafficEventPayload`.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class IngestionTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
    }

    public function test_records_a_row_with_canonical_fields(): void {
        $request = [
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/blog/post?utm_source=chatgpt.com',
            'HTTP_USER_AGENT'=> 'GPTBot/1.2',
            'REMOTE_ADDR'    => '203.0.113.4',
            'HTTP_REFERER'   => 'https://chatgpt.com/',
        ];

        \Canonry\TrafficLogger\Recorder::record($request, /* status */ 200);

        global $wpdb;
        $rows = $wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [];
        $this->assertCount(1, $rows);

        $row = $rows[0];
        $this->assertSame('GET', $row['method']);
        $this->assertSame('example.com', $row['host']);
        $this->assertSame('/blog/post', $row['path']);
        $this->assertSame('utm_source=chatgpt.com', $row['query_string']);
        $this->assertSame(200, $row['status']);
        $this->assertSame('GPTBot/1.2', $row['user_agent']);
        $this->assertSame('https://chatgpt.com/', $row['referer']);
        $this->assertSame('203.0.113.4', $row['remote_ip']);
        $this->assertMatchesRegex('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/', $row['observed_at']);
    }

    public function test_skips_admin_requests(): void {
        $request = [
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/wp-admin/edit.php',
            'HTTP_USER_AGENT'=> 'Mozilla/5.0',
            'REMOTE_ADDR'    => '203.0.113.4',
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $rows = $wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [];
        $this->assertCount(0, $rows);
    }

    public function test_skips_ajax_requests(): void {
        $request = [
            'REQUEST_METHOD' => 'POST',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/wp-admin/admin-ajax.php?action=heartbeat',
            'HTTP_USER_AGENT'=> 'Mozilla/5.0',
            'REMOTE_ADDR'    => '203.0.113.4',
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $rows = $wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [];
        $this->assertCount(0, $rows);
    }

    public function test_skips_post_requests(): void {
        $request = [
            'REQUEST_METHOD' => 'POST',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/2026/05/12/hello-world/',
            'HTTP_USER_AGENT'=> 'Mozilla/5.0',
            'REMOTE_ADDR'    => '203.0.113.4',
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $rows = $wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [];
        $this->assertCount(0, $rows);
    }

    public function test_null_query_when_no_query_string(): void {
        $request = [
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/about',
            'HTTP_USER_AGENT'=> 'Mozilla/5.0',
            'REMOTE_ADDR'    => '203.0.113.4',
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $row = ($wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [])[0] ?? null;
        $this->assertNotNull($row);
        $this->assertNull($row['query_string']);
    }

    public function test_handles_missing_optional_headers(): void {
        $request = [
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/x',
            // no UA, no referer, no remote addr
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $row = ($wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [])[0] ?? null;
        $this->assertNotNull($row);
        $this->assertNull($row['user_agent']);
        $this->assertNull($row['referer']);
        $this->assertNull($row['remote_ip']);
    }

    public function test_records_forwarded_ip_when_trust_proxy_enabled(): void {
        // End-to-end: the trusted-proxy option flows through Recorder ->
        // Plugin::trustProxy() -> ClientIp::resolve(), so a CDN-fronted
        // request is logged with the real visitor IP, not the edge IP.
        update_option('canonry_traffic_logger_trust_proxy', '1');

        $request = [
            'REQUEST_METHOD'       => 'GET',
            'HTTP_HOST'            => 'example.com',
            'REQUEST_URI'          => '/blog/post',
            'HTTP_USER_AGENT'      => 'GPTBot/1.2',
            'REMOTE_ADDR'          => '198.51.100.1',   // CDN edge
            'HTTP_X_FORWARDED_FOR' => '9.9.9.9',        // real visitor
        ];

        \Canonry\TrafficLogger\Recorder::record($request, 200);

        global $wpdb;
        $row = ($wpdb->rows[$wpdb->prefix . 'canonry_traffic_events'] ?? [])[0] ?? null;
        $this->assertNotNull($row);
        $this->assertSame('9.9.9.9', $row['remote_ip']);
    }
}
