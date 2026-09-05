# MCP server management

English | [中文](mcp.zh.md)

The user-managed list of MCP servers and the bridge instance each enabled entry becomes. [`dsh-mcp-client`](../../packages/mcp/mcp-client/README.md) owns one server's connection and the tools it registers; this page covers the layer above it: the settings namespace holding the list, the reconciliation that turns a list edit into mount and dispose actions, and the status a configuration surface reads back.

## The server list

The `mcp` settings namespace holds one `servers` array, registered with `applies: 'live'` so an edit takes effect in the running process. Each `McpServerEntry` is either a stdio server (`command`, `args`, `env`, `cwd`) or a Streamable HTTP server (`url`, `headers`), discriminated by `transport`, and every entry carries the stable `serverName` that namespaces its tools and an `enabled` flag deciding whether the manager mounts it. `serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique across the list — a constraint the schema cannot express on its own, so the namespace's validate hook refuses a duplicate section before anything persists.

## Reconciliation

A list edit runs one reconcile pass: disposals first, then mounts, so an entry that changed while enabled releases its old bridge before the new one reserves the namespace. An entry is disposed when it vanished, was disabled, or changed while enabled, and mounted when it is new, was re-enabled, or changed. A mount that fails is contained and recorded rather than propagated, so one broken server never blocks its siblings.

## Status and the Remote namespace

The manager provides `mcpStatusSink`, the sink every mounted mcp-client instance reports its connection state to, and keeps the latest report per `serverName`. Its own teardown signal is not a connection state, so a `disposed` report is dropped and the status is cleared when a server is disposed. `McpServerStatusView` is the client-safe row a configuration surface reads: the server name, the connection state, the tool names currently registered under it, and the latest failure text when there is one.

## Events

`mcp/status` is the Host-side notification emitted on every connection transition. It is payload-free by design: a configuration surface re-reads the manager's `list` Remote method for the new state instead of trusting a pushed snapshot, so a missed or reordered read cannot leave a stale row on screen.

## Service behavior

[`McpManager`](../../packages/mcp/mcp-manager/src/manager.ts) mounts and reconciles the bridges and serves the `mcp` Remote namespace; it requires `dsh-settings` and registers no configuration of its own. The package [README](../../packages/mcp/mcp-manager/README.md) defines the namespace, the reconcile rules, and the Remote methods. The [tools subsystem](tools.md) owns what each mounted bridge registers into the model.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="mcp-events"></a>

### `mcp/*` events

<a id="mcpstatus--emit"></a>

#### `mcp/status` — emit

One server's live connection status changed. Payload-free: a configuration surface re-reads the manager's `list` Remote method for the new state.

```ts cordis-catalog
/**
 * One server's live connection status changed. Payload-free: a
 * configuration surface re-reads the manager's `list` Remote method for
 * the new state.
 * @mode emit
 */
'mcp/status'(): void
```

Source: [`packages/mcp/mcp-manager/src/status.ts`](../../packages/mcp/mcp-manager/src/status.ts)
<!-- END GENERATED cordis-surface -->
