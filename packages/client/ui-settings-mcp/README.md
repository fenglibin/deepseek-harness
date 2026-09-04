---
description: "MCP servers settings surface: the user-managed MCP server list with add, edit, remove, and enable flows."
---

# dsh-client-ui-settings-mcp

`dsh-client-ui-settings-mcp` renders the MCP navigation entry in the settings shell: a server list the user can add to, edit, remove, and enable, over the `mcp` settings namespace owned by the Host `dsh-mcp-manager` plugin. It is a pure surface package — the node half is an empty apply so the plugin appears in the Loader, and the browser half registers the `settings.section` entry and a store bound to the namespace. The Host manager reconciles every settings change into mcp-client instances; this package only writes the list.

## What it edits

The `mcp` namespace holds one `servers` array. Each entry is either a stdio server (`serverName`, `enabled`, `transport: 'stdio'`, `command`, `args`, `env`, `cwd`) or a Streamable HTTP server (`serverName`, `enabled`, `transport: 'streamable-http'`, `url`, `headers`). The dialog stages one entry and writes only on save; an enable toggle writes immediately because it is a single visible decision.

The `env` and `headers` maps are edited as one `KEY=value` (or `Header: value`) per line. They are ordinary fields, not `role('secret')`, because the list is edited wholesale from the settings wire view — a redacted field would be silently dropped on every write.

## How it works

The section binds a `SettingsScope` over the `mcp` namespace and publishes a snapshot the list renders from. Every add, remove, update, and enable rewrites the whole `servers` array in one revision-fenced mutation; a write that lands on a moved revision fails rather than clobbering the newer answer. `serverName` is the stable identity the manager and every tool name are keyed by, so it is read-only once an entry exists.

## Related documentation

- [MCP manager](../mcp/mcp-manager/README.md) — the Host plugin that mounts each entry as an mcp-client instance.
- [MCP client](../mcp/mcp-client/README.md) — the bridge each entry becomes.
- [MCP package group](../mcp/README.md) — the group overview.
