<?php
/**
 * Minimal test harness for the canonry traffic-logger plugin.
 *
 * No PHPUnit dependency on the host. Tests are plain PHP scripts that
 * extend this class and register cases by calling `->run()` on a method.
 * The runner in `test/run-tests.php` discovers `*Test.php` files,
 * instantiates each, and invokes every public method whose name starts
 * with `test_`.
 *
 * Why not PHPUnit? The repo has no PHP toolchain (no composer, no docker
 * daemon at build time). Vendoring PHPUnit added > 30 min of setup with
 * no marginal value over a 100-line harness for the assertions we need.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger\Test;

abstract class TestCase {
    /** @var array<int, array{name:string,error:string,trace:string}> */
    public array $failures = [];
    public int $passed = 0;
    public int $assertions = 0;

    /**
     * Override to reset fixtures before each test_* method runs.
     */
    public function setUp(): void {}

    /**
     * Override to clean up after each test_* method runs.
     */
    public function tearDown(): void {}

    public function assertSame($expected, $actual, string $message = ''): void {
        $this->assertions++;
        if ($expected !== $actual) {
            $this->fail(sprintf(
                "%sassertSame failed.\n  Expected: %s\n  Actual:   %s",
                $message ? $message . "\n  " : '',
                self::format($expected),
                self::format($actual)
            ));
        }
    }

    public function assertEquals($expected, $actual, string $message = ''): void {
        $this->assertions++;
        if ($expected != $actual) { // intentional loose compare
            $this->fail(sprintf(
                "%sassertEquals failed.\n  Expected: %s\n  Actual:   %s",
                $message ? $message . "\n  " : '',
                self::format($expected),
                self::format($actual)
            ));
        }
    }

    public function assertTrue($value, string $message = ''): void {
        $this->assertions++;
        if ($value !== true) {
            $this->fail(($message ? $message . "\n  " : '') . 'assertTrue failed; got ' . self::format($value));
        }
    }

    public function assertFalse($value, string $message = ''): void {
        $this->assertions++;
        if ($value !== false) {
            $this->fail(($message ? $message . "\n  " : '') . 'assertFalse failed; got ' . self::format($value));
        }
    }

    public function assertNull($value, string $message = ''): void {
        $this->assertions++;
        if ($value !== null) {
            $this->fail(($message ? $message . "\n  " : '') . 'assertNull failed; got ' . self::format($value));
        }
    }

    public function assertNotNull($value, string $message = ''): void {
        $this->assertions++;
        if ($value === null) {
            $this->fail(($message ? $message . "\n  " : '') . 'assertNotNull failed');
        }
    }

    public function assertCount(int $expected, $actual, string $message = ''): void {
        $this->assertions++;
        if (!is_array($actual) && !($actual instanceof \Countable)) {
            $this->fail(($message ? $message . "\n  " : '') . 'assertCount: not countable');
        }
        $count = is_array($actual) ? count($actual) : $actual->count();
        if ($count !== $expected) {
            $this->fail(sprintf(
                '%sassertCount failed. Expected %d, got %d',
                $message ? $message . "\n  " : '',
                $expected,
                $count
            ));
        }
    }

    public function assertStringContainsString(string $needle, string $haystack, string $message = ''): void {
        $this->assertions++;
        if (strpos($haystack, $needle) === false) {
            $this->fail(sprintf(
                "%sassertStringContainsString failed.\n  Needle:   %s\n  Haystack: %s",
                $message ? $message . "\n  " : '',
                self::format($needle),
                self::format($haystack)
            ));
        }
    }

    public function assertMatchesRegex(string $pattern, string $value, string $message = ''): void {
        $this->assertions++;
        if (preg_match($pattern, $value) !== 1) {
            $this->fail(sprintf(
                "%sassertMatchesRegex failed.\n  Pattern: %s\n  Value:   %s",
                $message ? $message . "\n  " : '',
                $pattern,
                self::format($value)
            ));
        }
    }

    public function assertArrayHasKey(string $key, array $arr, string $message = ''): void {
        $this->assertions++;
        if (!array_key_exists($key, $arr)) {
            $this->fail(sprintf(
                '%sassertArrayHasKey failed: missing "%s". Keys present: %s',
                $message ? $message . "\n  " : '',
                $key,
                implode(', ', array_keys($arr))
            ));
        }
    }

    public function assertThrows(callable $fn, ?string $expectedClass = null, ?string $expectedMessagePart = null): void {
        $this->assertions++;
        try {
            $fn();
        } catch (\Throwable $e) {
            if ($expectedClass !== null && !($e instanceof $expectedClass)) {
                $this->fail('assertThrows: expected ' . $expectedClass . ' but got ' . get_class($e) . ': ' . $e->getMessage());
            }
            if ($expectedMessagePart !== null && strpos($e->getMessage(), $expectedMessagePart) === false) {
                $this->fail('assertThrows: message missing "' . $expectedMessagePart . '"; got "' . $e->getMessage() . '"');
            }
            return;
        }
        $this->fail('assertThrows: no exception thrown');
    }

    protected function fail(string $message): void {
        throw new AssertionFailed($message);
    }

    private static function format($value): string {
        if (is_string($value)) return '"' . $value . '"';
        if (is_null($value)) return 'null';
        if (is_bool($value)) return $value ? 'true' : 'false';
        if (is_array($value) || is_object($value)) return json_encode($value, JSON_UNESCAPED_SLASHES) ?: '[unencodable]';
        return (string) $value;
    }
}

class AssertionFailed extends \Exception {}
