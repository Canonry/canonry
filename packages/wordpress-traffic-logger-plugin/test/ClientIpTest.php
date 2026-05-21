<?php
/**
 * Client IP resolution. With trust-proxy off only REMOTE_ADDR is used, so a
 * visitor cannot forge their source IP. With it on, single-IP CDN headers
 * win, and X-Forwarded-For is read right-to-left so a prepended forgery is
 * ignored in favor of the address the trusted proxy actually observed.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;
use Canonry\TrafficLogger\ClientIp;

final class ClientIpTest extends TestCase {
    public function test_untrusted_uses_remote_addr(): void {
        $this->assertSame('203.0.113.7', ClientIp::resolve(['REMOTE_ADDR' => '203.0.113.7'], false));
    }

    public function test_untrusted_ignores_forwarded_headers(): void {
        // On a non-proxied site, forwarded headers are visitor-controllable
        // and must be ignored: REMOTE_ADDR is the only trustworthy address.
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'           => '203.0.113.7',
            'HTTP_X_FORWARDED_FOR'  => '8.8.8.8',
            'HTTP_CF_CONNECTING_IP' => '8.8.4.4',
        ], false);
        $this->assertSame('203.0.113.7', $ip);
    }

    public function test_trusted_prefers_cf_connecting_ip(): void {
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'           => '198.51.100.1',
            'HTTP_CF_CONNECTING_IP' => '203.0.113.9',
            'HTTP_X_FORWARDED_FOR'  => '8.8.8.8, 198.51.100.1',
        ], true);
        $this->assertSame('203.0.113.9', $ip);
    }

    public function test_trusted_true_client_ip_beats_forwarded_for(): void {
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'          => '198.51.100.1',
            'HTTP_TRUE_CLIENT_IP'  => '203.0.113.10',
            'HTTP_X_FORWARDED_FOR' => '8.8.8.8',
        ], true);
        $this->assertSame('203.0.113.10', $ip);
    }

    public function test_trusted_uses_x_real_ip(): void {
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'    => '198.51.100.1',
            'HTTP_X_REAL_IP' => '203.0.113.11',
        ], true);
        $this->assertSame('203.0.113.11', $ip);
    }

    public function test_trusted_xff_skips_private_internal_hop(): void {
        // "client, internal-hop": the rightmost public entry is the client.
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'          => '198.51.100.1',
            'HTTP_X_FORWARDED_FOR' => '8.8.8.8, 10.0.0.5',
        ], true);
        $this->assertSame('8.8.8.8', $ip);
    }

    public function test_trusted_xff_ignores_prepended_forgery(): void {
        // A visitor prepends a fake entry; the trusted proxy appends the
        // address it actually saw. Reading right-to-left picks the real one.
        $ip = ClientIp::resolve([
            'REMOTE_ADDR'          => '198.51.100.1',
            'HTTP_X_FORWARDED_FOR' => '1.2.3.4, 9.9.9.9',
        ], true);
        $this->assertSame('9.9.9.9', $ip);
    }

    public function test_trusted_falls_back_to_remote_addr(): void {
        $this->assertSame('203.0.113.30', ClientIp::resolve(['REMOTE_ADDR' => '203.0.113.30'], true));
    }

    public function test_invalid_or_missing_ip_is_null(): void {
        $this->assertNull(ClientIp::resolve(['REMOTE_ADDR' => 'not-an-ip'], false));
        $this->assertNull(ClientIp::resolve(['REMOTE_ADDR' => ''], false));
        $this->assertNull(ClientIp::resolve([], false));
    }

    public function test_ipv6_address_is_accepted(): void {
        $this->assertSame('2001:db8::1', ClientIp::resolve(['REMOTE_ADDR' => '2001:db8::1'], false));
    }
}
