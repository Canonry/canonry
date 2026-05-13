<?php
/**
 * Retention auto-prune lifecycle. Cron event is scheduled at activation,
 * cleared at uninstall, and the prune callback deletes events older than
 * `canonry_traffic_logger_retention_days` (default 90) while leaving
 * newer events untouched.
 *
 * Why daily? The retention window is a coarse property (days), so the
 * prune cadence does not need to be sub-daily. Daily also keeps the
 * shutdown-hook fast path completely unburdened.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Test\TestCase;

final class RetentionTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
    }

    public function test_activation_schedules_daily_prune_event(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        $next = wp_next_scheduled(\Canonry\TrafficLogger\Plugin::PRUNE_HOOK);
        $this->assertNotNull($next);
        $this->assertTrue($next !== false, 'prune hook must be scheduled after activation');

        $recurrence = $GLOBALS['__wp_scheduled_recurrence'][\Canonry\TrafficLogger\Plugin::PRUNE_HOOK] ?? null;
        $this->assertSame('daily', $recurrence);
    }

    public function test_activation_does_not_double_schedule(): void {
        \Canonry\TrafficLogger\Plugin::activate();
        $firstTs = wp_next_scheduled(\Canonry\TrafficLogger\Plugin::PRUNE_HOOK);

        \Canonry\TrafficLogger\Plugin::activate();
        $secondTs = wp_next_scheduled(\Canonry\TrafficLogger\Plugin::PRUNE_HOOK);

        $this->assertSame($firstTs, $secondTs, 're-activation must not reschedule a fresh event');
    }

    public function test_uninstall_clears_scheduled_prune(): void {
        \Canonry\TrafficLogger\Plugin::activate();
        $this->assertTrue(wp_next_scheduled(\Canonry\TrafficLogger\Plugin::PRUNE_HOOK) !== false);

        \Canonry\TrafficLogger\Plugin::uninstall();
        $this->assertFalse(wp_next_scheduled(\Canonry\TrafficLogger\Plugin::PRUNE_HOOK));
    }

    public function test_default_retention_is_90_days(): void {
        $this->assertSame(90, \Canonry\TrafficLogger\Plugin::retentionDays());
    }

    public function test_retention_days_respects_option(): void {
        update_option(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, 30);
        $this->assertSame(30, \Canonry\TrafficLogger\Plugin::retentionDays());
    }

    public function test_retention_days_clamps_below_minimum(): void {
        update_option(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, 1);
        $this->assertSame(7, \Canonry\TrafficLogger\Plugin::retentionDays());
    }

    public function test_retention_days_clamps_above_maximum(): void {
        update_option(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, 9999);
        $this->assertSame(365, \Canonry\TrafficLogger\Plugin::retentionDays());
    }

    public function test_prune_deletes_events_older_than_retention_window(): void {
        \Canonry\TrafficLogger\Plugin::activate();
        update_option(\Canonry\TrafficLogger\Plugin::RETENTION_OPTION, 30);

        global $wpdb;
        $table = $wpdb->prefix . \Canonry\TrafficLogger\Recorder::TABLE;
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        // Seed three rows: 60d old (prune), 5d old (keep), now (keep).
        $sixtyDaysAgo = $now->modify('-60 days')->format('Y-m-d\TH:i:s.v\Z');
        $fiveDaysAgo  = $now->modify('-5 days')->format('Y-m-d\TH:i:s.v\Z');
        $rightNow     = $now->format('Y-m-d\TH:i:s.v\Z');

        $wpdb->insert($table, ['observed_at' => $sixtyDaysAgo, 'path' => '/old']);
        $wpdb->insert($table, ['observed_at' => $fiveDaysAgo,  'path' => '/recent']);
        $wpdb->insert($table, ['observed_at' => $rightNow,     'path' => '/now']);

        $this->assertCount(3, $wpdb->rows[$table]);

        \Canonry\TrafficLogger\Plugin::pruneExpired();

        $remaining = array_map(fn($r) => $r['path'], $wpdb->rows[$table] ?? []);
        sort($remaining);
        $this->assertSame(['/now', '/recent'], $remaining);
    }

    public function test_prune_no_op_when_table_empty(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        // Should not throw even with an empty table.
        \Canonry\TrafficLogger\Plugin::pruneExpired();

        global $wpdb;
        $table = $wpdb->prefix . \Canonry\TrafficLogger\Recorder::TABLE;
        $this->assertSame(0, count($wpdb->rows[$table] ?? []));
    }

    public function test_prune_uses_default_when_option_unset(): void {
        \Canonry\TrafficLogger\Plugin::activate();

        global $wpdb;
        $table = $wpdb->prefix . \Canonry\TrafficLogger\Recorder::TABLE;
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        // Default is 90 days; row at 100d should be deleted, row at 80d should remain.
        $oldRow    = $now->modify('-100 days')->format('Y-m-d\TH:i:s.v\Z');
        $recentRow = $now->modify('-80 days')->format('Y-m-d\TH:i:s.v\Z');

        $wpdb->insert($table, ['observed_at' => $oldRow,    'path' => '/old']);
        $wpdb->insert($table, ['observed_at' => $recentRow, 'path' => '/keep']);

        \Canonry\TrafficLogger\Plugin::pruneExpired();

        $remaining = array_map(fn($r) => $r['path'], $wpdb->rows[$table] ?? []);
        $this->assertSame(['/keep'], $remaining);
    }
}
