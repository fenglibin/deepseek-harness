---
description: "User-managed MCP server list mounted as mcp-client instances."
---

# dsh-mcp-manager

`dsh-mcp-manager` owns one user-managed list of MCP servers and mounts a `dsh-mcp-client` instance per enabled entry. It is the user-facing counterpart to the bare mcp-client plugin: instead of hand-editing one `cordis.yml` row per server, a configuration surface reads and writes a single `mcp` settings section, and the manager reconciles the live mcp-client set on every change. Add it when users should manage MCP servers through a UI; nothing ships enabled, so you opt in per server.

## Configuration

The manager registers the `mcp` settings namespace. The section is a list of server entries; each entry carries a stable `serverName`, an `enabled` flag, a transport, and the transport's fields:

```yaml
mcp:
  servers:
    - serverName: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: 'your-token'
    - serverName: web
      transport: streamable-http
      url: http://localhost:3000/mcp
      headers:
        Authorization: 'Bearer token'
```

`env` and `headers` values are ordinary fields, not `role('secret')`, because the list is edited wholesale from the settings wire view — a redacted field would be silently dropped on every write. Every other field is `enabled` (default true), the transport, `command`/`args`/`cwd` for stdio, or `url`/`headers` for Streamable HTTP. The reconnect policy, per-call timeout, and startup semantics keep the mcp-client defaults.

`serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique across the list; a duplicate rejects the section at write time. A disabled entry keeps its configuration but mounts no instance, so re-enabling restores the exact tool set.

## How it works

The manager provides the `mcpStatusSink` service that every mounted mcp-client instance reads, so it observes each server's `connecting` → `connected` → `reconnecting` → `failed` lifecycle. On a settings change it reconciles the previous and next lists: disposals first (removed, disabled, and changed-while-enabled entries), then mounts (new, re-enabled, and changed entries). A mount that fails is contained and logged, so one broken server never blocks its siblings.

The bare `dsh-mcp-client` plugin remains unchanged — each server is still one mcp-client instance under a stable `serverName`, still registered through Cordis's plugin lifecycle. The manager only changes who creates and destroys those instances, from boot-time `cordis.yml` rows to runtime settings changes. It also exports an `mcp` Remote namespace: `list()` returns each server's live status and tool names, and `refresh(name)` forces one server to reconnect by disposing and remounting its mcp-client instance.

## Related documentation

- [MCP client plugin](../mcp-client/README.md) — the bridge the manager mounts.
- [MCP package group](../README.md) — the group overview.
