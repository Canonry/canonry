<?php
/**
 * Window filter: GET /wp-json/canonry/v1/events accepts `since` and `until`
 * ISO 8601 query parameters and returns only events whose `observed_at`
 * falls in `[since, until)`.
 *
 * Lower bound is INCLUSIVE, upper bound is EXCLUSIVE — matching the
 * half-open window convention used by the canonry TS backfill route
 * (delete inclusive on tsHour, insert inclusive; the plugin keeps the
 * upper boundary exclusive so the next adjacent window picks up its own
 * lower bound without overlap). Tests pin this contract.
 *
 * The filter is independent of the cursor pagination: callers can scope
 * to a window AND page through it. CursorPaginationTest covers the
 * unfiltered baseline; this file covers window scoping + invalid input.
 */
declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class WindowFilterTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
        $GLOBALS['__wp_current_user_can'] = true;
    }

    /**
     * Seed five rows at one-minute intervals from 12:00:00 — 12:00:04 so the
     * window tests have unambiguous in/out membership without TZ drift.
     */
    private function seed(): void {
        global $wpdb;
        $table = $wpdb->prefix . 'canonry_traffic_events';
        for ($i = 0; $i < 5; $i++) {
            $wpdb->insert($table, [
                'observed_at'    => sprintf('2026-05-11T12:00:%02d.000Z', $i),
                'method'         => 'GET',
                'host'           => 'example.com',
                'path'           => '/p/' . $i,
                'query_string'   => null,
                'status'         => 200,
                'user_agent'     => 'GPTBot/1.2',
                'remote_ip'      => null,
                'referer'        => null,
            ]);
        }
    }

    public function test_since_only_returns_events_at_or_after_lower_bound(): void {
        $this->seed();
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'since' => '2026-05-11T12:00:02.000Z',
        ], []);
        $resp = \Canonry\TrafficLogger\Rest::handleList($req);
        $body = $resp->get_data();

        // /p/2, /p/3, /p/4 — boundary at /p/2 is INCLUSIVE
        $this->assertCount(3, $body['events']);
        $this->assertSame('/p/2', $body['events'][0]['path']);
        $this->assertSame('/p/3', $body['events'][1]['path']);
        $this->assertSame('/p/4', $body['events'][2]['path']);
    }

    public function test_until_only_returns_events_strictly_before_upper_bound(): void {
        $this->seed();
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'until' => '2026-05-11T12:00:03.000Z',
        ], []);
        $resp = \Canonry\TrafficLogger\Rest::handleList($req);
        $body = $resp->get_data();

        // /p/0, /p/1, /p/2 — upper at /p/3 is EXCLUSIVE
        $this->assertCount(3, $body['events']);
        $this->assertSame('/p/0', $body['events'][0]['path']);
        $this->assertSame('/p/1', $body['events'][1]['path']);
        $this->assertSame('/p/2', $body['events'][2]['path']);
    }

    public function test_since_and_until_together_returns_half_open_window(): void {
        $this->seed();
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'since' => '2026-05-11T12:00:01.000Z',
            'until' => '2026-05-11T12:00:04.000Z',
        ], []);
        $resp = \Canonry\TrafficLogger\Rest::handleList($req);
        $body = $resp->get_data();

        // /p/1, /p/2, /p/3 — /p/0 is below since, /p/4 is at-or-above until
        $this->assertCount(3, $body['events']);
        $this->assertSame('/p/1', $body['events'][0]['path']);
        $this->assertSame('/p/2', $body['events'][1]['path']);
        $this->assertSame('/p/3', $body['events'][2]['path']);
    }

    public function test_invalid_since_returns_400(): void {
        $this->seed();
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'since' => 'not-a-timestamp',
        ], []);
        $result = \Canonry\TrafficLogger\Rest::handleList($req);
        $this->assertTrue($result instanceof \WP_Error);
        $this->assertSame(400, $result->get_error_data()['status'] ?? null);
    }

    public function test_invalid_until_returns_400(): void {
        $this->seed();
        $req = new \WP_REST_Request('GET', [
            'limit' => 10,
            'until' => 'definitely-not-iso',
        ], []);
        $result = \Canonry\TrafficLogger\Rest::handleList($req);
        $this->assertTrue($result instanceof \WP_Error);
        $this->assertSame(400, $result->get_error_data()['status'] ?? null);
    }

    public function test_window_pagination_works_with_cursor(): void {
        // Window filter must coexist with cursor pagination — events inside the
        // window get paged through in the usual (observed_at, id) order.
        $this->seed();
        $req1 = new \WP_REST_Request('GET', [
            'limit' => 2,
            'since' => '2026-05-11T12:00:01.000Z',
            'until' => '2026-05-11T12:00:04.000Z',
        ], []);
        $resp1 = \Canonry\TrafficLogger\Rest::handleList($req1);
        $body1 = $resp1->get_data();

        $this->assertCount(2, $body1['events']);
        $this->assertSame('/p/1', $body1['events'][0]['path']);
        $this->assertSame('/p/2', $body1['events'][1]['path']);
        $this->assertTrue($body1['has_more']);
        $this->assertNotNull($body1['next_cursor']);

        // Second page: cursor + same window must return /p/3 only.
        $req2 = new \WP_REST_Request('GET', [
            'limit' => 2,
            'since' => '2026-05-11T12:00:01.000Z',
            'until' => '2026-05-11T12:00:04.000Z',
            'cursor' => $body1['next_cursor'],
        ], []);
        $resp2 = \Canonry\TrafficLogger\Rest::handleList($req2);
        $body2 = $resp2->get_data();

        $this->assertCount(1, $body2['events']);
        $this->assertSame('/p/3', $body2['events'][0]['path']);
        $this->assertFalse($body2['has_more']);
        $this->assertNull($body2['next_cursor']);
    }
}
