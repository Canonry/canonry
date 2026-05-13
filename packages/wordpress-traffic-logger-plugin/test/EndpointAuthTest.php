<?php
/**
 * REST endpoint authentication: no/invalid auth returns 401; valid auth
 * (Application Password) returns 200 with the WordpressTrafficEventsPage shape.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class EndpointAuthTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
    }

    public function test_rejects_unauthenticated_requests_with_401(): void {
        // No current user, current_user_can returns false.
        $GLOBALS['__wp_current_user_can'] = false;

        $req = new \WP_REST_Request('GET', [], []);
        $result = \Canonry\TrafficLogger\Rest::checkPermission($req);

        $this->assertTrue($result instanceof \WP_Error);
        $this->assertSame(401, $result->get_error_data()['status'] ?? null);
    }

    public function test_accepts_authenticated_with_manage_options(): void {
        $GLOBALS['__wp_current_user_can'] = true;

        $req = new \WP_REST_Request('GET', [], []);
        $result = \Canonry\TrafficLogger\Rest::checkPermission($req);

        $this->assertTrue($result === true);
    }

    public function test_handler_returns_envelope_shape(): void {
        $GLOBALS['__wp_current_user_can'] = true;

        // Seed one row.
        \Canonry\TrafficLogger\Recorder::record([
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/one',
            'HTTP_USER_AGENT'=> 'GPTBot/1.2',
            'REMOTE_ADDR'    => '203.0.113.4',
        ], 200);

        $req = new \WP_REST_Request('GET', ['limit' => 10], []);
        $response = \Canonry\TrafficLogger\Rest::handleList($req);

        $this->assertTrue($response instanceof \WP_REST_Response);
        $this->assertSame(200, $response->get_status());

        $body = $response->get_data();
        $this->assertArrayHasKey('events', $body);
        $this->assertArrayHasKey('next_cursor', $body);
        $this->assertArrayHasKey('has_more', $body);

        $this->assertCount(1, $body['events']);
        $event = $body['events'][0];

        // Mirror WordpressTrafficEventPayload exactly.
        foreach (['id', 'observed_at', 'method', 'host', 'path', 'query_string', 'status', 'user_agent', 'remote_ip_hash', 'referer'] as $expected) {
            $this->assertArrayHasKey($expected, $event);
        }

        $this->assertSame('/one', $event['path']);
        $this->assertSame('example.com', $event['host']);
        $this->assertSame('GET', $event['method']);
        $this->assertSame(200, $event['status']);
        $this->assertSame('GPTBot/1.2', $event['user_agent']);
        $this->assertMatchesRegex('/^[0-9a-f]{12}$/', $event['remote_ip_hash']);
    }
}
