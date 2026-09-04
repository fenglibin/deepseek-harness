---
description: "Web Session-log ZIP export: Host streaming, the authenticated download route, the Session Header action, and the /export command."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

English | [中文](README.zh.md)

## Summary

`dsh-session-log-export` lets the Web interface download a session's history: a `Session log` button in the Session Header and an `/export` slash command both hand the current session's own log and its attachments to the browser as a ZIP download. The button's range menu widens one download to the whole session tree — the session plus every subagent descendant and the media those logs reference. The package owns the Host archive stream, its authenticated Fetch route, and the browser controls and feedback. The browser chooses the download destination. Setup and usage come first; implementation details follow.

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

Use this package when the Web bundle should let users export a session log. It requires Connection, the command registry, Session query and persistence, and attachments. Mount the plugin, then click `Session log` in the Session Header or type `/export`; the browser downloads `dsh-session-<id>.zip` carrying the current session alone. The arrow beside the button opens a range menu whose `Include sub-Sessions` row adds every subagent descendant's log to that download.

### When to choose it

Choose it for a Web deployment that needs user-facing session export with a Header control and a failure dialog. Avoid it when a programmatic or Host-side export is needed: this package produces a browser download, not a Host path write, and it requires a persistence backend that stores a per-session raw artifact (the shipped JSONL backend supports plaintext and zstd; SQLite export is not supported).

### Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The Web bundle mounts the package with Connection, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `compressionLevel` | `6` | DEFLATE level from 0 through 9 for each ZIP entry. |

### Command contract

| Input | Result |
|---|---|
| `/export` | Records a human-command lifecycle; the submitting browser downloads `GET /api/session.export?sessionId=<id>&includeDescendants=false` |
| `/export <path>` | An error; browser downloads choose their destination through the browser's ordinary download behavior |

### What to expect

A download starts in the gesture that requested it, and the browser download manager is the feedback: no dialog appears while the preflight runs or after the save starts, so the failure dialog below is the only dialog this package opens. One session admits one active download at a time; repeated gestures share that operation. Both paths export the current session alone; choosing `Include sub-Sessions` is the only browser action that widens the archive to the descendant tree, and that choice applies to the one gesture that made it, never to later downloads. The export includes the live session's newest events: the host endpoint flushes a live root session before reading, so a slash-triggered ZIP includes the `command/run` and `command/done` pair that started the download; cold persisted sessions need no flush.

### Failures

The failure dialog opens when the preflight fails before ZIP streaming starts — for example an unreachable or misconfigured host endpoint — and shows the HTTP detail, or a generic sentence when the response carries none. A descendant or attachment read failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package wires the export control and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design split

The package has two halves. The Host half ([`src/index.ts`](src/index.ts)) registers the `/export` command and contributes the exact `GET`/`HEAD /api/session.export` Fetch route to Connection; [`src/archive.ts`](src/archive.ts) builds the bounded ZIP stream. The browser half ([`src/client/index.ts`](src/client/index.ts)) provides the shared download controller and UI, and observes `command/executed` so only the submitting browser starts a download.

### Download flow

Both entry paths issue a `HEAD` preflight to `GET /api/session.export?...`, then hand the GET URL to the browser download manager without buffering the ZIP in JavaScript. Both pass one range: `includeDescendants=false` by default and `true` only when the Header menu's sub-Session row started the download, so the default archive carries the current session's own log and the media it references. One controller owns one in-flight download per session, collapses concurrent gestures into that operation, and cancels the preflight on plugin disposal. Download state lives in a snapshot store keyed by session, so the button and the command share one failure dialog per session; only a failed preflight publishes an open dialog, and the browser download manager reports every download that starts.

The Host route is a feature-owned exact Fetch contribution. Connection applies its Host/Origin and browser-session checks and bridges the streaming `Response`; this package owns query validation, live-session flushes, raw artifact and attachment reads, ZIP generation, and HTTP status semantics.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the Web control to the host endpoint and the surrounding command and session surfaces.

- [dsh-client-connection](../../client/connection/README.md) — the authenticated Fetch-route carrier used by the Host endpoint.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry the `/export` command registers on.
- [dsh-client-ui-commands](../../client/ui-commands/README.md) — the browser command surface that renders and acknowledges `/export`.
- [Session Query package map](../README.md) — the retrieval family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser download do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Requires a per-session raw artifact backend** — the download endpoint needs a persistence backend with a per-session raw artifact; the shipped JSONL backend supports plaintext and zstd, and SQLite export is not supported.
- **Browser download, not a Host-path writer** — the browser chooses the local destination; no Host path or native folder action is returned.
- **Preflight reports only pre-stream failures** — a descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: export destinations beyond the browser

The download is deliberately browser-scoped; a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

</details>
