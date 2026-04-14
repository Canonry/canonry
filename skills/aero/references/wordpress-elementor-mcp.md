# Elementor + WordPress MCP Development Guide

## Overview

This guide covers programmatic management of WordPress + Elementor sites using the Elementor MCP plugin. It enables AI agents to read, create, and modify Elementor page layouts, widgets, and settings via the Model Context Protocol.

## Prerequisites

### WordPress Side
- WordPress >= 6.8
- Elementor >= 3.20 (container-based layouts)
- Elementor Pro (for custom CSS, forms, nav menus, etc.)
- **WordPress MCP Adapter** plugin ([GitHub](https://github.com/WordPress/mcp-adapter))
- **Elementor MCP** plugin ([GitHub](https://github.com/msrbuilds/elementor-mcp))
- Application Password created for API auth (Users > Profile > Application Passwords)
- Permalinks set to "Post name" (required for `/wp-json/` REST API routing)

### Client Side
- `.mcp.json` in project root with HTTP MCP server config
- Base64-encoded credentials: `echo -n "username:app-password" | base64`

## MCP Configuration

```json
{
  "mcpServers": {
    "elementor-staging": {
      "type": "http",
      "url": "https://your-staging-site.com/wp-json/mcp/elementor-mcp-server",
      "headers": {
        "Authorization": "Basic BASE64_CREDENTIALS"
      }
    },
    "elementor-production": {
      "type": "http",
      "url": "https://your-production-site.com/wp-json/mcp/elementor-mcp-server",
      "headers": {
        "Authorization": "Basic BASE64_CREDENTIALS"
      }
    }
  }
}
```

### Troubleshooting Connection Issues
- If `/wp-json/` returns 404: go to Settings > Permalinks, set to "Post name", click Save
- If auth fails (401): verify application password is correct and user has admin role
- If MCP endpoint 404 but `/wp-json/` works: re-activate both MCP plugins
- After staging re-clone: re-install plugins, re-create app password, re-save permalinks

## Elementor Architecture

### Element Hierarchy
```
Page
 └── Container (root section)
      └── Container (hero/section)
           └── Container (row/column)
                └── Widget (heading, text-editor, button, etc.)
```

### Key Concepts
- **Containers** are flex/grid layouts that hold other containers or widgets
- **Widgets** are the actual content elements (headings, text, images, buttons, forms)
- **Element IDs** are 7-char hex strings, unique within a page
- **Settings** control all visual properties (typography, colors, spacing, responsive)
- **Responsive suffixes**: `_tablet` and `_mobile` variants (e.g., `typography_font_size_tablet`)

### Common Widget Types
- `heading` — H1-H6 titles
- `text-editor` — Rich text content
- `button` — CTA buttons with links
- `image` / `image-box` — Images with optional text
- `form` — Contact/lead forms (Pro)
- `google_maps` — Embedded maps
- `html` — Custom HTML (used for JSON-LD schema injection)
- `reviews` — Testimonials
- `nested-tabs` / `nested-accordion` — Tabbed/accordion content

## Core MCP Workflow

### 1. Discovery

```
list-pages              → Get all Elementor pages with IDs
get-page-structure      → See element tree (containers + widgets)
get-element-settings    → Inspect any element's full settings
find-element            → Search by text content, widget type, or setting
list-widgets            → See all available widget types
get-widget-schema       → Get available settings for a widget type
```

### 2. Content Updates

```
update-widget           → Change text, links, colors, typography (partial merge)
update-container        → Change layout, spacing, alignment, background
add-heading             → Add a heading widget
add-text-editor         → Add a text block
add-button              → Add a CTA button
add-html                → Add custom HTML (JSON-LD schema, tracking scripts)
add-container           → Add a layout container
```

### 3. Structure Changes

```
move-element            → Reorder or re-parent elements
remove-element          → Delete an element
duplicate-element       → Clone an element
reorder-elements        → Change sibling order
```

### 4. Styling

```
add-custom-css          → Page-level or element-level CSS (use media queries for responsive)
update-global-colors    → Site-wide color palette
update-global-typography → Site-wide font presets
```

### 5. Page Management

```
create-page             → New WordPress page with Elementor
build-page              → Create complete page from declarative JSON
export-page             → Get full page data
delete-page-content     → Clear page content
```

## Best Practices

### Staging-First Workflow
1. Make all changes on staging via MCP
2. Verify visually across viewports (use Chrome browser tools)
3. Get human approval
4. Replay changes on production via MCP
5. Re-clone staging from production for next iteration

### Responsive Design
- Always check 3 breakpoints: desktop (1440+), tablet (768-1024), mobile (375-390)
- Use `_tablet` and `_mobile` setting suffixes for responsive overrides
- For large desktop fixes (1800px+), use `add-custom-css` with media queries
- Elementor's breakpoints: desktop (default), tablet (1024px), mobile (767px)

### Settings Merge Behavior
- `update-widget` and `update-container` do **partial merges** — only specified settings change
- Nested objects (like `margin`, `padding`, `typography_font_size`) must include all subkeys
- Example margin: `{"unit": "px", "top": "0", "right": "0", "bottom": "0", "left": "20", "isLinked": false}`

### CSS Custom Overrides
- Use `add-custom-css` with `replace: true` to avoid CSS accumulation
- Use `selector` keyword for element-level CSS: `selector .heading { color: red; }`
- Wrap responsive fixes in `@media` queries to avoid affecting other breakpoints
- Always verify CSS doesn't break other viewports after applying

### JSON-LD Schema Injection
- Use `add-html` widget with `<script type="application/ld+json">` content
- Place in root container (append position -1) — script tags produce no visible output
- Use distinct `@id` values that don't conflict with Yoast's auto-generated schema
- Yoast generates: WebPage, BreadcrumbList, WebSite, Organization
- Custom schema should use: Service, RoofingContractor, DefinedTerm, LocalBusiness, etc.

### Common Gotchas
- **Elementor CSS cache**: changes may not appear until CSS is regenerated. Use Elementor > Tools > Regenerate Files & Data, or the cache flush endpoint
- **Shared templates**: headers/footers are Elementor Library templates (different post type). Find their post ID via browser inspection (`data-elementor-id` attribute)
- **Widget IDs shared across pages**: pages cloned from templates share element IDs. Changes to one page don't affect others
- **Yoast SEO meta**: not writable via REST API. Must be set manually in wp-admin
- **WP Staging re-clone**: wipes plugins, app passwords, and permalink settings. Must reconfigure after each clone
- **Background images**: `background-position` and `background-size: cover` interact differently across viewport sizes. Use browser tools to measure actual rendered positions

## Quick Reference: Common Operations

### Change heading text
```
update-widget(post_id, element_id, {"title": "New Heading"})
```

### Change text block content
```
update-widget(post_id, element_id, {"editor": "<p>New content</p>"})
```

### Change font size (responsive)
```
update-widget(post_id, element_id, {
  "typography_font_size": {"unit": "px", "size": 80, "sizes": []},
  "typography_font_size_tablet": {"unit": "px", "size": 65, "sizes": []},
  "typography_font_size_mobile": {"unit": "px", "size": 40, "sizes": []}
})
```

### Change container margin
```
update-container(post_id, element_id, {
  "margin": {"unit": "px", "top": "0", "right": "0", "bottom": "0", "left": "250", "isLinked": false}
})
```

### Add JSON-LD schema to a page
```
add-html(post_id, parent_id, '<script type="application/ld+json">{"@context":"https://schema.org",...}</script>')
```

### Add responsive CSS fix
```
add-custom-css(post_id, '@media (min-width: 1800px) { .elementor-element-XXXXX { margin-top: -200px !important; } }', replace=true)
```

### Find text on a page
```
find-element(post_id, search_text="lorem ipsum")
```

### Update Google Maps widget
```
update-widget(post_id, element_id, {"address": "Southeast Michigan, USA", "zoom": {"unit": "px", "size": 8, "sizes": []}})
```
