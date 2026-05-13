<?php
/**
 * IP hashing is deterministic per-salt. Same IP + same salt -> same hash;
 * different salt -> different hash. Hash is first 12 hex chars of sha256.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class IpHashTest extends TestCase {
    public function test_same_ip_same_salt_deterministic(): void {
        $a = \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'salt-one');
        $b = \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'salt-one');
        $this->assertSame($a, $b);
    }

    public function test_same_ip_different_salt_diverges(): void {
        $a = \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'salt-one');
        $b = \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'salt-two');
        $this->assertTrue($a !== $b);
    }

    public function test_hash_is_12_hex_chars(): void {
        $h = \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'some-salt');
        $this->assertMatchesRegex('/^[0-9a-f]{12}$/', $h);
    }

    public function test_null_or_empty_ip_returns_null(): void {
        $this->assertNull(\Canonry\TrafficLogger\IpHasher::hash(null, 'salt'));
        $this->assertNull(\Canonry\TrafficLogger\IpHasher::hash('', 'salt'));
    }

    public function test_matches_sha256_first_12_chars(): void {
        $expected = substr(hash('sha256', '203.0.113.4' . 'fixed-salt'), 0, 12);
        $this->assertSame($expected, \Canonry\TrafficLogger\IpHasher::hash('203.0.113.4', 'fixed-salt'));
    }
}
