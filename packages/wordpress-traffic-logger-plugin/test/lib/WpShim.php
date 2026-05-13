<?php
/**
 * Test-only shim for the subset of WordPress globals + functions the
 * canonry traffic-logger plugin uses. Real WP installs supply these
 * natively; this shim makes the plugin code unit-testable in isolation.
 *
 * KEEP THIS THIN. Only stub what plugin code actually calls. Anything
 * exotic should be refactored into a pure function in `plugin/includes/`
 * that takes the WP-y dependency as an argument so it can be tested
 * without growing this shim.
 */

declare(strict_types=1);

// --- Hook registry --------------------------------------------------------

if (!isset($GLOBALS['__wp_actions'])) {
    $GLOBALS['__wp_actions'] = [];
}
if (!isset($GLOBALS['__wp_filters'])) {
    $GLOBALS['__wp_filters'] = [];
}
if (!isset($GLOBALS['__wp_rest_routes'])) {
    $GLOBALS['__wp_rest_routes'] = [];
}
if (!isset($GLOBALS['__wp_options'])) {
    $GLOBALS['__wp_options'] = [];
}
if (!isset($GLOBALS['__wp_scheduled'])) {
    $GLOBALS['__wp_scheduled'] = [];
}
if (!isset($GLOBALS['__wp_scheduled_recurrence'])) {
    $GLOBALS['__wp_scheduled_recurrence'] = [];
}
if (!isset($GLOBALS['__wp_options_pages'])) {
    $GLOBALS['__wp_options_pages'] = [];
}
if (!isset($GLOBALS['__wp_registered_settings'])) {
    $GLOBALS['__wp_registered_settings'] = [];
}
if (!isset($GLOBALS['__wp_settings_fields'])) {
    $GLOBALS['__wp_settings_fields'] = [];
}
if (!isset($GLOBALS['__wp_settings_sections'])) {
    $GLOBALS['__wp_settings_sections'] = [];
}

if (!function_exists('add_action')) {
    function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): bool {
        $GLOBALS['__wp_actions'][$hook][] = ['cb' => $callback, 'priority' => $priority];
        return true;
    }
}

if (!function_exists('add_filter')) {
    function add_filter(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): bool {
        $GLOBALS['__wp_filters'][$hook][] = ['cb' => $callback, 'priority' => $priority];
        return true;
    }
}

if (!function_exists('do_action')) {
    function do_action(string $hook, ...$args): void {
        foreach ($GLOBALS['__wp_actions'][$hook] ?? [] as $entry) {
            ($entry['cb'])(...$args);
        }
    }
}

if (!function_exists('apply_filters')) {
    function apply_filters(string $hook, $value, ...$args) {
        foreach ($GLOBALS['__wp_filters'][$hook] ?? [] as $entry) {
            $value = ($entry['cb'])($value, ...$args);
        }
        return $value;
    }
}

if (!function_exists('register_rest_route')) {
    function register_rest_route(string $namespace, string $route, array $args = [], bool $override = false): bool {
        $GLOBALS['__wp_rest_routes'][$namespace . $route] = $args;
        return true;
    }
}

if (!function_exists('register_activation_hook')) {
    function register_activation_hook(string $file, callable $cb): void {
        $GLOBALS['__wp_activation_hooks'][$file] = $cb;
    }
}

if (!function_exists('register_deactivation_hook')) {
    function register_deactivation_hook(string $file, callable $cb): void {
        $GLOBALS['__wp_deactivation_hooks'][$file] = $cb;
    }
}

if (!function_exists('register_uninstall_hook')) {
    function register_uninstall_hook(string $file, callable $cb): void {
        $GLOBALS['__wp_uninstall_hooks'][$file] = $cb;
    }
}

// --- Options API ----------------------------------------------------------

if (!function_exists('get_option')) {
    function get_option(string $key, $default = false) {
        return $GLOBALS['__wp_options'][$key] ?? $default;
    }
}

if (!function_exists('update_option')) {
    function update_option(string $key, $value, $autoload = null): bool {
        $GLOBALS['__wp_options'][$key] = $value;
        return true;
    }
}

if (!function_exists('add_option')) {
    function add_option(string $key, $value): bool {
        if (array_key_exists($key, $GLOBALS['__wp_options'])) return false;
        $GLOBALS['__wp_options'][$key] = $value;
        return true;
    }
}

if (!function_exists('delete_option')) {
    function delete_option(string $key): bool {
        if (!array_key_exists($key, $GLOBALS['__wp_options'])) return false;
        unset($GLOBALS['__wp_options'][$key]);
        return true;
    }
}

// --- Sanitization & escaping ---------------------------------------------

if (!function_exists('sanitize_text_field')) {
    function sanitize_text_field(string $str): string {
        $filtered = trim(preg_replace('/[\r\n\t\0\x0B]/', '', $str));
        return $filtered;
    }
}

if (!function_exists('esc_url_raw')) {
    function esc_url_raw(string $url): string {
        return filter_var($url, FILTER_SANITIZE_URL) ?: '';
    }
}

if (!function_exists('esc_html')) {
    function esc_html(string $str): string {
        return htmlspecialchars($str, ENT_QUOTES, 'UTF-8');
    }
}

if (!function_exists('esc_attr')) {
    function esc_attr(string $str): string {
        return htmlspecialchars($str, ENT_QUOTES, 'UTF-8');
    }
}

if (!function_exists('wp_unslash')) {
    function wp_unslash($value) {
        if (is_array($value)) return array_map('wp_unslash', $value);
        if (is_string($value)) return stripslashes($value);
        return $value;
    }
}

if (!function_exists('absint')) {
    function absint($maybeInt): int {
        return abs((int) $maybeInt);
    }
}

// --- Time / random ---------------------------------------------------------

if (!function_exists('current_time')) {
    function current_time(string $type, int $gmt = 0): string {
        if ($type === 'mysql') {
            return gmdate('Y-m-d H:i:s');
        }
        if ($type === 'timestamp') {
            return (string) time();
        }
        return gmdate('c');
    }
}

if (!function_exists('wp_generate_password')) {
    function wp_generate_password(int $length = 12, bool $special_chars = true): string {
        return bin2hex(random_bytes((int) ceil($length / 2)));
    }
}

// --- Scheduling -----------------------------------------------------------

if (!function_exists('wp_next_scheduled')) {
    function wp_next_scheduled(string $hook) {
        return $GLOBALS['__wp_scheduled'][$hook] ?? false;
    }
}

if (!function_exists('wp_schedule_event')) {
    function wp_schedule_event(int $timestamp, string $recurrence, string $hook): bool {
        $GLOBALS['__wp_scheduled'][$hook] = $timestamp;
        $GLOBALS['__wp_scheduled_recurrence'][$hook] = $recurrence;
        return true;
    }
}

if (!function_exists('wp_clear_scheduled_hook')) {
    function wp_clear_scheduled_hook(string $hook): void {
        unset($GLOBALS['__wp_scheduled'][$hook]);
        unset($GLOBALS['__wp_scheduled_recurrence'][$hook]);
    }
}

// --- Admin menu & Settings API -------------------------------------------

if (!function_exists('add_options_page')) {
    function add_options_page(
        string $page_title,
        string $menu_title,
        string $capability,
        string $menu_slug,
        $callback = null
    ): string {
        $GLOBALS['__wp_options_pages'][] = [
            'page_title' => $page_title,
            'menu_title' => $menu_title,
            'capability' => $capability,
            'menu_slug'  => $menu_slug,
            'callback'   => $callback,
        ];
        return $menu_slug;
    }
}

if (!function_exists('register_setting')) {
    function register_setting(string $option_group, string $option_name, array $args = []): void {
        $GLOBALS['__wp_registered_settings'][$option_name] = [
            'option_group' => $option_group,
            'option_name'  => $option_name,
            'args'         => $args,
        ];
    }
}

if (!function_exists('add_settings_section')) {
    function add_settings_section(string $id, string $title, $callback, string $page): void {
        $GLOBALS['__wp_settings_sections'][$page][$id] = [
            'id'       => $id,
            'title'    => $title,
            'callback' => $callback,
        ];
    }
}

if (!function_exists('add_settings_field')) {
    function add_settings_field(
        string $id,
        string $title,
        $callback,
        string $page,
        string $section = 'default',
        array $args = []
    ): void {
        $GLOBALS['__wp_settings_fields'][$page][$section][$id] = [
            'id'       => $id,
            'title'    => $title,
            'callback' => $callback,
            'args'     => $args,
        ];
    }
}

if (!function_exists('settings_fields')) {
    function settings_fields(string $option_group): void {
        echo '<input type="hidden" name="option_page" value="' . esc_attr($option_group) . '" />';
    }
}

if (!function_exists('do_settings_sections')) {
    function do_settings_sections(string $page): void {
        foreach ($GLOBALS['__wp_settings_sections'][$page] ?? [] as $section) {
            if (is_callable($section['callback'])) {
                ($section['callback'])();
            }
            foreach ($GLOBALS['__wp_settings_fields'][$page][$section['id']] ?? [] as $field) {
                if (is_callable($field['callback'])) {
                    ($field['callback'])($field['args']);
                }
            }
        }
    }
}

if (!function_exists('submit_button')) {
    function submit_button(string $text = 'Save Changes'): void {
        echo '<input type="submit" value="' . esc_attr($text) . '" />';
    }
}

if (!function_exists('wp_die')) {
    function wp_die(string $message = '', string $title = '', $args = []): void {
        throw new \RuntimeException($message !== '' ? $message : 'wp_die invoked');
    }
}

// --- REST classes ---------------------------------------------------------

if (!class_exists('WP_REST_Request')) {
    class WP_REST_Request {
        /** @var array<string, mixed> */
        private array $params;
        /** @var array<string, string> */
        private array $headers;
        public string $method;

        public function __construct(string $method = 'GET', array $params = [], array $headers = []) {
            $this->method = $method;
            $this->params = $params;
            $this->headers = $headers;
        }

        public function get_param(string $key) {
            return $this->params[$key] ?? null;
        }

        public function get_params(): array {
            return $this->params;
        }

        public function get_header(string $key): ?string {
            $normalized = strtolower($key);
            foreach ($this->headers as $h => $v) {
                if (strtolower($h) === $normalized) return $v;
            }
            return null;
        }
    }
}

if (!class_exists('WP_REST_Response')) {
    class WP_REST_Response {
        public $data;
        public int $status;
        public array $headers;

        public function __construct($data = null, int $status = 200, array $headers = []) {
            $this->data = $data;
            $this->status = $status;
            $this->headers = $headers;
        }

        public function get_status(): int { return $this->status; }
        public function get_data() { return $this->data; }
    }
}

if (!class_exists('WP_Error')) {
    class WP_Error {
        public string $code;
        public string $message;
        public array $data;

        public function __construct(string $code = '', string $message = '', array $data = []) {
            $this->code = $code;
            $this->message = $message;
            $this->data = $data;
        }

        public function get_error_code(): string { return $this->code; }
        public function get_error_message(): string { return $this->message; }
        public function get_error_data(): array { return $this->data; }
    }
}

if (!function_exists('is_wp_error')) {
    function is_wp_error($thing): bool {
        return $thing instanceof WP_Error;
    }
}

if (!function_exists('rest_authorization_required_code')) {
    function rest_authorization_required_code(): int { return 401; }
}

if (!function_exists('current_user_can')) {
    function current_user_can(string $capability): bool {
        return $GLOBALS['__wp_current_user_can'] ?? false;
    }
}

if (!function_exists('wp_get_current_user')) {
    function wp_get_current_user() {
        if (!isset($GLOBALS['__wp_current_user'])) {
            $stub = new \stdClass();
            $stub->ID = 0;
            $stub->user_login = '';
            return $stub;
        }
        return $GLOBALS['__wp_current_user'];
    }
}

// --- DB ---------------------------------------------------------

if (!function_exists('dbDelta')) {
    function dbDelta(string $sql): array {
        // No-op in tests; ::wpdb_mock should be used directly to seed rows.
        return [];
    }
}

if (!defined('ABSPATH')) {
    define('ABSPATH', '/srv/wp/');
}

if (!defined('WPINC')) {
    define('WPINC', 'wp-includes');
}

/**
 * Lightweight wpdb mock supporting insert/get_results/prepare/query
 * against an in-memory rows array.
 */
class WpdbMock {
    public string $prefix = 'wp_';
    public string $last_query = '';
    public ?string $last_error = null;
    public int $insert_id = 0;
    /** @var array<string, array<int, array<string,mixed>>> */
    public array $rows = [];
    public int $next_id = 1;

    public function prepare(string $sql, ...$args): string {
        // Replace placeholders with safely-escaped args. This is good
        // enough for tests; the plugin code must still use prepare()
        // properly so the real wpdb does correct escaping.
        $flat = $args;
        if (count($args) === 1 && is_array($args[0])) {
            $flat = $args[0];
        }
        $i = 0;
        return preg_replace_callback('/%[ds]/', function ($m) use (&$i, $flat) {
            $v = $flat[$i++] ?? '';
            if ($m[0] === '%d') return (string) (int) $v;
            return "'" . str_replace("'", "''", (string) $v) . "'";
        }, $sql) ?? $sql;
    }

    public function insert(string $table, array $data, $format = null): int {
        if (!isset($this->rows[$table])) $this->rows[$table] = [];
        $data['id'] = $this->next_id++;
        $this->rows[$table][] = $data;
        $this->insert_id = (int) $data['id'];
        return 1;
    }

    public function get_results(string $sql, string $output_type = 'OBJECT'): array {
        $this->last_query = $sql;
        // Naive parse: SELECT ... FROM <table> WHERE ... ORDER BY ... LIMIT n
        if (!preg_match('/FROM\s+([a-z0-9_]+)/i', $sql, $m)) return [];
        $table = $m[1];
        $rows = $this->rows[$table] ?? [];

        // Optional cursor + window filters. The plugin composes the WHERE
        // clause from up to three independent ANDed predicates, all anchored
        // on `observed_at`:
        //   - cursor:  ((observed_at > 'x') OR (observed_at = 'x' AND id > n))
        //   - since:   observed_at >= 'x'
        //   - until:   observed_at < 'x'
        // Each predicate is detected with its own regex so the order /
        // combination doesn't matter — the shim filters the row set down by
        // every clause it finds.
        if (preg_match(
            "/\\(\\(observed_at\\s*>\\s*'([^']*)'\\)\\s+OR\\s+\\(observed_at\\s*=\\s*'([^']*)'\\s+AND\\s+id\\s*>\\s*(\\d+)\\)\\)/i",
            $sql,
            $cur
        )) {
            $afterTs = $cur[1];
            $afterId = (int) $cur[3];
            $rows = array_values(array_filter($rows, function ($r) use ($afterTs, $afterId) {
                if ($r['observed_at'] > $afterTs) return true;
                if ($r['observed_at'] === $afterTs && (int) $r['id'] > $afterId) return true;
                return false;
            }));
        }

        if (preg_match("/observed_at\\s*>=\\s*'([^']*)'/i", $sql, $sm)) {
            $since = $sm[1];
            $rows = array_values(array_filter($rows, fn($r) => ((string) $r['observed_at']) >= $since));
        }

        if (preg_match("/observed_at\\s*<\\s*'([^']*)'/i", $sql, $um)) {
            $until = $um[1];
            $rows = array_values(array_filter($rows, fn($r) => ((string) $r['observed_at']) < $until));
        }

        // ORDER BY observed_at ASC, id ASC (only ordering we use).
        usort($rows, function ($a, $b) {
            $cmp = strcmp((string) $a['observed_at'], (string) $b['observed_at']);
            if ($cmp !== 0) return $cmp;
            return ((int) $a['id']) - ((int) $b['id']);
        });

        if (preg_match('/LIMIT\s+(\d+)/i', $sql, $lim)) {
            $rows = array_slice($rows, 0, (int) $lim[1]);
        }

        if ($output_type === 'ARRAY_A') {
            return $rows;
        }
        return array_map(fn($r) => (object) $r, $rows);
    }

    public function get_var(string $sql) {
        $this->last_query = $sql;
        if (!preg_match('/FROM\s+([a-z0-9_]+)/i', $sql, $m)) return null;
        $table = $m[1];
        $rows = $this->rows[$table] ?? [];
        if (preg_match('/SELECT\s+COUNT\s*\(\s*\*\s*\)/i', $sql)) {
            return count($rows);
        }
        if (preg_match('/SELECT\s+MIN\s*\(\s*observed_at\s*\)/i', $sql)) {
            if (count($rows) === 0) return null;
            $values = array_map(fn($r) => (string) ($r['observed_at'] ?? ''), $rows);
            sort($values);
            return $values[0];
        }
        return null;
    }

    public function query(string $sql): int {
        $this->last_query = $sql;
        // Support DELETE FROM <table> WHERE observed_at < 'x'
        if (preg_match("/DELETE\\s+FROM\\s+([a-z0-9_]+)\\s+WHERE\\s+observed_at\\s*<\\s*'([^']*)'/i", $sql, $m)) {
            $table = $m[1];
            $before = $m[2];
            $rows = $this->rows[$table] ?? [];
            $kept = array_values(array_filter($rows, fn($r) => ((string) $r['observed_at']) >= $before));
            $deleted = count($rows) - count($kept);
            $this->rows[$table] = $kept;
            return $deleted;
        }
        if (preg_match("/DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?([a-z0-9_]+)/i", $sql, $m)) {
            unset($this->rows[$m[2]]);
            return 1;
        }
        return 0;
    }

    public function get_charset_collate(): string {
        return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
    }
}

/**
 * Reset the WP shim's mutable globals between tests.
 */
function wpshim_reset(): void {
    $GLOBALS['__wp_actions'] = [];
    $GLOBALS['__wp_filters'] = [];
    $GLOBALS['__wp_rest_routes'] = [];
    $GLOBALS['__wp_options'] = [];
    $GLOBALS['__wp_scheduled'] = [];
    $GLOBALS['__wp_scheduled_recurrence'] = [];
    $GLOBALS['__wp_options_pages'] = [];
    $GLOBALS['__wp_registered_settings'] = [];
    $GLOBALS['__wp_settings_sections'] = [];
    $GLOBALS['__wp_settings_fields'] = [];
    $GLOBALS['__wp_current_user_can'] = false;
    $GLOBALS['wpdb'] = new WpdbMock();
}

// Initialize a default wpdb so plugin file loading can call $wpdb references safely.
if (!isset($GLOBALS['wpdb'])) {
    $GLOBALS['wpdb'] = new WpdbMock();
}
