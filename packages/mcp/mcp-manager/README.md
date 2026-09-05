---
description: "User-managed MCP server list mounted as live mcp-client instances: the Host-side reconciliation of one settings namespace into one bridge per enabled server."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` owns one user-managed list of MCP servers and mounts a `dsh-mcp-client` instance per enabled entry, reconciling the live set on every settings change. It is the user-facing counterpart to the bare mcp-client plugin: instead of hand-editing one `cordis.yml` row per server, a configuration surface reads and writes a single `mcp` settings section, and the manager mounts, disposes, or replaces exactly the bridges those edits imply. It also reports each server's live connection state, diagnostic text, and tool names over an `mcp` Remote namespace, so a settings surface can show what a user's edit actually did. Add it when MCP servers are user data managed at runtime; nothing ships enabled, so every server stays an explicit opt-in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-mcp-manager` in a Host composition that also mounts `dsh-settings`, then let users add servers through a configuration surface. Each enabled entry becomes one live mcp-client instance whose tools the model can call under that server's name.

### When to choose it

Choose the manager when MCP servers are user data: they change while the process runs, they differ per user, and a settings surface should own them. Choose bare `dsh-mcp-client` rows instead when servers are deployment data — fixed at composition time, identical for every user, and reviewed like any other `cordis.yml` entry. The two are not exclusive: a deployment may ship fixed rows and let users add their own, because each server is namespaced by its own `serverName`.

### Minimal configuration

The plugin takes no configuration and mounts as one composition row:

```yaml
- name: '@deepseek-ai/dsh-mcp-manager'
```

The [configuration catalog](../../../docs/config-catalog.md) lists no fields for it: the server list is settings data carried in the `mcp` namespace, not plugin configuration.

### The server list

The `mcp` namespace holds one `servers` array. Each entry carries a stable `serverName`, an `enabled` flag, a transport, and that transport's fields:

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

`serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique across the list; a duplicate rejects the section at write time, before anything persists. A disabled entry keeps its configuration but mounts no instance, so re-enabling restores the exact tool set. `env` and `headers` are ordinary fields rather than secret-role ones, because the list is edited wholesale from the settings wire view and a redacted field would be silently dropped on every write. The reconnect policy, per-call timeout, and startup semantics keep the mcp-client defaults.

### Reconciliation

Every accepted settings change runs one reconcile pass: disposals first, then mounts, so an entry that changed while enabled releases its old bridge before the new one reserves the namespace. A mount that fails is contained and logged and is recorded as a `failed` status with its diagnostic, so one broken server never blocks its siblings and a surface can explain why a server never came up instead of answering `unknown` forever.

### Status and the Remote namespace

The manager exports an `mcp` Remote namespace for configuration surfaces. `list()` returns one row per configured server — its connection state, the tool names it currently registers, and the latest failure text when there is one — and `refresh(name)` forces one server to reconnect by disposing and remounting its instance. The manager also emits a payload-free `mcp/status` event on every transition, so a surface re-pulls instead of polling.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manager is one service over two seams: a settings namespace it owns, and the mcp-client plugin it mounts once per enabled entry.

### The settings namespace

The service registers `mcp` with `applies: 'live'` and a validate hook, so a change takes effect in the running process and a section reusing a `serverName` is refused before it persists — the schema cannot express cross-entry uniqueness on its own. The initial mount runs once at startup from the stored list, and every later change runs through the same serialized reconcile chain, so an initial mount and a settings-driven one never interleave.

### The reconcile pass

Reconciliation is pure: `reconcile(prev, next)` returns an ordered action list, disposals before mounts, comparing entries by `serverName` and by value. An entry is disposed when it vanished, was disabled, or changed while enabled; it is mounted when it is new, was re-enabled, or changed. The service executes those actions in order and keeps the chain tail alive through a failure, so a rejected mount never strands the next reconcile.

### The status sink

The service provides `mcpStatusSink`, the sink every mounted mcp-client instance reads, and records each report by `serverName`. Its own teardown signal is not a connection state, so a `disposed` report is dropped and the status is cleared when the manager disposes a server. A report also emits `mcp/status`; because the manager contains and logs sink failures, a throwing listener cannot break the reconnect loop it only observes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the bridge each entry becomes, the browser surface that edits the list, and the durable settings seam behind it.

- [mcp-client](../mcp-client/README.md) — the bridge the manager mounts per enabled entry.
- [ui-settings-mcp](../../client/ui-settings-mcp/README.md) — the browser surface that edits this namespace.
- [settings](../../settings/README.md) — the durable user-settings seam carrying the server list.
- [tools](../../core/tools/README.md) — the tool registry each mounted bridge registers into.
- [MCP package group](../README.md) — the group overview.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the mcp-client instances the manager mounts, which own every `mcp__<serverName>__<rawName>` tool schema, description, and result they register for the server name the user chose.

#### KV Cache effect

A server-list edit changes the request prefix for every later request in that session, because mounting or disposing a server adds or removes the tool definitions that server owns; the manager itself writes nothing model-visible, and an edit that reconciles to no action leaves the prefix untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the manager can reconcile and what a configuration surface can learn from it; they are current package constraints.

- **Servers are user-wide, not per-session** — the list lives in one settings document, so an entry a user adds is visible to every session that process serves; there is no per-session or per-project server list.
- **No secret-role fields** — `env` and `headers` are stored as plain text because the list is edited wholesale from the wire view; a deployment that needs those values redacted at rest must keep them out of this namespace.
- **Reconnect policy is not configurable here** — the backoff, attempt budget, and per-call timeout stay the mcp-client defaults, so tuning one server's resilience means configuring that server's own entry rather than the manager.
- **Status is last-known, not live-pushed** — the `mcp/status` event carries no payload, so a surface re-reads `list()` after one; a transition that races with a re-pull is visible at the next event or refresh.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
