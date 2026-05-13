<?php
/**
 * Test runner for the canonry traffic-logger plugin.
 *
 * Usage: php test/run-tests.php
 *
 * Discovers all test/*Test.php files, requires them, instantiates every
 * class that extends Canonry\TrafficLogger\Test\TestCase, and runs every
 * public method that starts with `test_`.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/TestCase.php';
require_once __DIR__ . '/lib/WpShim.php';

use Canonry\TrafficLogger\Test\TestCase;
use Canonry\TrafficLogger\Test\AssertionFailed;

// Discover and load test files.
$testFiles = glob(__DIR__ . '/*Test.php') ?: [];
foreach ($testFiles as $file) {
    require_once $file;
}

// Find all TestCase subclasses among declared classes.
$totalTests = 0;
$totalPassed = 0;
$totalFailed = 0;
$totalAssertions = 0;
$allFailures = [];
$startedAt = microtime(true);

foreach (get_declared_classes() as $class) {
    if (!is_subclass_of($class, TestCase::class)) continue;
    $reflection = new ReflectionClass($class);
    if ($reflection->isAbstract()) continue;

    foreach ($reflection->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        if (strpos($method->getName(), 'test_') !== 0) continue;
        $totalTests++;
        $instance = new $class();
        $testName = $class . '::' . $method->getName();

        try {
            $instance->setUp();
            $method->invoke($instance);
            $instance->tearDown();
            $totalPassed++;
            $totalAssertions += $instance->assertions;
            fwrite(STDOUT, ".");
        } catch (AssertionFailed $e) {
            $totalFailed++;
            $totalAssertions += $instance->assertions;
            $allFailures[] = ['name' => $testName, 'message' => $e->getMessage(), 'trace' => $e->getTraceAsString()];
            fwrite(STDOUT, "F");
        } catch (\Throwable $e) {
            $totalFailed++;
            $totalAssertions += $instance->assertions;
            $allFailures[] = [
                'name' => $testName,
                'message' => 'Unexpected exception: ' . get_class($e) . ': ' . $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ];
            fwrite(STDOUT, "E");
        }
    }
}

$elapsed = microtime(true) - $startedAt;
fwrite(STDOUT, "\n\n");

if ($allFailures !== []) {
    fwrite(STDOUT, "Failures:\n\n");
    foreach ($allFailures as $i => $failure) {
        fwrite(STDOUT, sprintf("%d) %s\n%s\n\n", $i + 1, $failure['name'], $failure['message']));
        if (getenv('VERBOSE') === '1') {
            fwrite(STDOUT, $failure['trace'] . "\n\n");
        }
    }
}

fwrite(STDOUT, sprintf(
    "Tests: %d, Passed: %d, Failed: %d, Assertions: %d (%.3fs)\n",
    $totalTests,
    $totalPassed,
    $totalFailed,
    $totalAssertions,
    $elapsed
));

exit($totalFailed > 0 ? 1 : 0);
