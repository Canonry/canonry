<?php
/**
 * Cursor pagination: first page + second page (using next_cursor) returns
 * disjoint sets ordered by (observed_at, id).
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class CursorPaginationTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
        $GLOBALS['__wp_current_user_can'] = true;
    }

    /**
     * Seed N rows with monotonically increasing observed_at (so order is
     * deterministic and the (observed_at, id) walk is exercised).
     */
    private function seed(int $n): void {
        global $wpdb;
        $table = $wpdb->prefix . 'canonry_traffic_events';
        for ($i = 1; $i <= $n; $i++) {
            $wpdb->insert($table, [
                'observed_at'    => sprintf('2026-05-11T12:00:%02d.000Z', $i),
                'method'         => 'GET',
                'host'           => 'example.com',
                'path'           => '/p/' . $i,
                'query_string'   => null,
                'status'         => 200,
                'user_agent'     => 'GPTBot/1.2',
                'remote_ip_hash' => null,
                'referer'        => null,
            ]);
        }
    }

    public function test_first_page_then_cursor_returns_disjoint_ordered_sets(): void {
        $this->seed(5);

        $req1 = new \WP_REST_Request('GET', ['limit' => 2], []);
        $resp1 = \Canonry\TrafficLogger\Rest::handleList($req1);
        $body1 = $resp1->get_data();

        $this->assertCount(2, $body1['events']);
        $this->assertSame('/p/1', $body1['events'][0]['path']);
        $this->assertSame('/p/2', $body1['events'][1]['path']);
        $this->assertTrue($body1['has_more']);
        $this->assertTrue(is_string($body1['next_cursor']) && $body1['next_cursor'] !== '');

        $req2 = new \WP_REST_Request('GET', [
            'limit' => 2,
            'cursor' => $body1['next_cursor'],
        ], []);
        $resp2 = \Canonry\TrafficLogger\Rest::handleList($req2);
        $body2 = $resp2->get_data();

        $this->assertCount(2, $body2['events']);
        $this->assertSame('/p/3', $body2['events'][0]['path']);
        $this->assertSame('/p/4', $body2['events'][1]['path']);
        $this->assertTrue($body2['has_more']);

        $req3 = new \WP_REST_Request('GET', [
            'limit' => 2,
            'cursor' => $body2['next_cursor'],
        ], []);
        $resp3 = \Canonry\TrafficLogger\Rest::handleList($req3);
        $body3 = $resp3->get_data();

        $this->assertCount(1, $body3['events']);
        $this->assertSame('/p/5', $body3['events'][0]['path']);
        $this->assertFalse($body3['has_more']);
        $this->assertNull($body3['next_cursor']);
    }

    public function test_invalid_cursor_string_rejected(): void {
        $this->seed(2);
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'cursor' => 'not-base64$$$',
        ], []);
        $result = \Canonry\TrafficLogger\Rest::handleList($req);
        $this->assertTrue($result instanceof \WP_Error);
        $this->assertSame(400, $result->get_error_data()['status'] ?? null);
    }
}
