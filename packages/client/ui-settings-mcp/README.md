---
description: "MCP servers settings section for the dsh web client: the user-managed MCP server list with add, edit, delete, and enable flows over the Host-owned mcp settings namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-mcp` is the **MCP** settings section of the dsh web client: users add, edit, delete, and enable the MCP servers the model may call tools from. The list is one `servers` array in the `mcp` settings namespace that the Host `dsh-mcp-manager` plugin owns, so this package registers no namespace of its own — it binds that namespace and rewrites the whole array in one revision-fenced mutation per change. A row shows the server's name, its command or URL, a live status dot, and the number of tools the manager currently reports for it; an add or edit opens one dialog that stages a single entry and writes only on save, while the row's switch writes immediately because enabling is a single visible decision. Choose it when users should manage MCP servers from the browser; the Host manager alone decides what each entry mounts.

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

Open **MCP** in Settings to see every configured server, its transport, its live connection state, and how many tools it registers. **Add server** opens a dialog for one new entry, **Edit** reopens that dialog on an existing entry, **Delete** removes an entry after a confirmation, the row's switch enables or disables it, and **Refresh** forces a running server to reconnect.

### When to choose it

Mount this package in a Web composition that also mounts `dsh-mcp-manager` and `dsh-client-ui-settings`. It edits a namespace it does not own: without the Host manager the section has nothing to bind and renders an empty list, and without the settings shell there is no section to host it. A deployment that manages every MCP server through `cordis.yml` rows needs neither this package nor the manager.

### Minimal configuration

The plugin takes no configuration and mounts as one composition row:

```yaml
- name: '@deepseek-ai/dsh-client-ui-settings-mcp'
```

The [configuration catalog](../../../docs/config-catalog.md) lists no fields for it: everything a user changes lands in the Host-owned `mcp` settings namespace instead.

### Editing and saving

The dialog stages one entry and writes only on save. A new entry's `serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique across the list; the section refuses a duplicate name before writing and keeps the dialog open. Once an entry exists its `serverName` is read-only, because the manager and every tool name are keyed by it. A stdio entry takes a command, space-separated arguments, a working directory, and one `KEY=value` per line of environment variables; a Streamable HTTP entry takes a URL and one `Header: value` per line of headers. Those two maps are ordinary fields rather than secret-role ones, because the list is rewritten wholesale from the wire view and a redacted field would be silently dropped on every write.

### Live status

Each row's dot follows the server's enabled flag first, then the connection state the manager reports: `disabled` while the entry is off, otherwise `connecting` or `reconnecting`, `connected`, `failed`, or `unknown` while a server has not reported yet. The section re-pulls status whenever the server list changes and whenever the manager pushes an `mcp/status` event, so a newly mounted server's state appears without a manual refresh. **Refresh** disposes the server's current bridge instance and mounts a fresh one, then re-pulls so the row shows the new state and tool count.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The section is one slot contribution over three injected services: a server-list store bound to the Host-owned settings namespace, a status store over the Host `mcp` Remote namespace, and the locale dictionary carrying its copy.

### The section registration

The browser half registers `settings.section` with the id `mcp` and order 20, so the settings shell places it after the entries claiming lower orders. Its node half is an empty `apply`: the plugin appears in the Loader and ships a browser bundle while owning no host-side behavior. The package registers no settings namespace — `ctx.settingsScope.bind({ namespace: 'mcp' })` reaches the section the Host manager registered.

### The write path

The list is one array, so every accepted change rewrites it whole in a single mutation fenced by the namespace revision the store last read: add, update, remove, and enable all resolve to one `set` of `servers` at that revision. A write that lands on a moved revision, targets a read-only document, or arrives while another save is crossing the wire is refused and reported rather than clobbering the newer answer. The store keeps its own `saving` and `failed` flags and republishes one snapshot per change, so the rows, the in-flight state, and the failure notice all read from the same source.

### The status overlay

The status store pulls the manager's `list` Remote method on demand and subscribes to the pushed `mcp/status` event to re-pull. A pull already in flight is never stacked: a pushed event during one raises a reload flag the in-flight pull honors when it settles. `refresh(name)` asks the manager to dispose the server's current mcp-client instance and mount a fresh one, then re-pulls so the row shows the new connection state and tool names.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings base, the Host manager that owns the namespace, and the bridge each entry becomes.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section` and the settings scope.
- [mcp-manager](../../mcp/mcp-manager/README.md) — the Host plugin that owns the `mcp` namespace and mounts each entry.
- [mcp-client](../../mcp/mcp-client/README.md) — the bridge each enabled entry becomes.
- [settings](../../settings/README.md) — the durable user-settings seam behind every namespace.
- [MCP package group](../../mcp/README.md) — the group overview.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the section can show and when a write is refused; they are current package constraints.

- **The Host owns the namespace** — this package renders whatever the `mcp` section holds and writes only through it, so a composition that never mounts `dsh-mcp-manager` shows an empty list rather than a local draft.
- **No secret-role fields** — `env` and `headers` are edited and stored as plain text because the list is rewritten wholesale from the wire view; a deployment that needs those values redacted at rest has to keep them out of this section.
- **Status arrives by re-pull, not as a stream** — the `mcp/status` event is payload-free, so the section re-reads every server's status after a list change or a pushed event; a transition the manager never pushes is visible only at the next re-pull or manual refresh.
- **One write at a time** — the store refuses a change while another save is in flight, so two rapid edits are serialized by whichever reaches the wire first.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
