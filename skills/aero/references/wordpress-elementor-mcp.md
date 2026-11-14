---
name: wordpress-elementor-mcp
description: Connect an external MCP client to EMCP Tools and inspect or edit Elementor pages. Read only for WordPress or Elementor page edits.
---

# Edit Elementor pages through MCP

EMCP Tools, formerly Elementor MCP, runs on the WordPress site. Use it from a
connected external MCP host for Elementor layout and widget changes. The
Canonry WordPress connection uses the WordPress REST API for its own commands.

## Connect the client

1. Install EMCP Tools and activate Elementor on the target site. Current EMCP
   Tools requires WordPress 6.9 or later and PHP 8.1 or later. Its package
   includes the WordPress MCP Adapter. See the [installation and requirements
   guide](https://emcptools.com/docs/getting-started/requirements/).
2. In WordPress, open **EMCP Tools → Connection**. Use the configuration the
   screen generates for your client. The default endpoint ends in
   `/wp-json/mcp/emcp-tools-server`. See the [Connection
   screen](https://emcptools.com/docs/admin/connection/).
3. Select Elementor in **EMCP Tools → Page Builders**. Use the tools the
   connected server exposes. Tool availability depends on the site's builder
   and enabled tools. See the [tool catalog](https://emcptools.com/docs/tools/overview/).

## Read the page before editing

1. Use `emcp-tools-list-pages` to get the target post ID.
2. Use `emcp-tools-get-page-structure` to find the container and widget IDs.
   On a large page, start with `summary: true` or a bounded `max_depth`.
3. Use `emcp-tools-get-element-settings` for the exact element's values.
   Use `emcp-tools-get-widget-schema` to check the widget's control names and
   value types. See the [discovery tools](https://emcptools.com/docs/tools/query-discovery/).

## Apply the update

Use staging when it is available. Verify WordPress host, post ID, and element
ID before applying an approved write. Page IDs can differ between staging and
production.

For an existing widget, `emcp-tools-update-widget` takes `post_id`,
`element_id`, and the `settings` to change. For a new widget, use the
exposed add tool for that widget's tier and pass the parent container ID.
See the [widget tools](https://emcptools.com/docs/tools/widgets/).

After the edit, read the element again. Open the page at desktop, tablet, and
mobile widths to check responsive settings. If the saved settings and
rendered page differ, check Elementor's generated CSS and page cache.

For metadata changes through Canonry, use `cnry wordpress page <project> <slug>`
to inspect the SEO fields. `cnry wordpress set-meta` can write fields the
WordPress REST API exposes as writable.
