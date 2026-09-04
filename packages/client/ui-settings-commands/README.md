---
description: "Prompt-command settings section: a user-editable list of reusable prompt shortcuts with add, edit, and confirmed delete."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-commands

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-commands` adds the Prompt Commands settings page. It edits the `prompt-commands` settings namespace — the user-editable list of reusable `/name` prompt shortcuts registered by `@deepseek-ai/dsh-command-prompt-config`. The list supports add and edit through a staged editor and delete through an in-page risk confirmation, so every change is explicit and reversible only by re-adding the command.

## Table of Contents

- [Use this package](#use-this-package)
- [Source map](#source-map)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Compose it beside the settings shell and the Host-side `command-prompt-config` plugin. The section renders nothing meaningful when the namespace is not served, but the section is always registered.

```yaml
- id: ui-settings
  name: '@deepseek-ai/dsh-client-ui-settings'
- id: ui-settings-commands
  name: '@deepseek-ai/dsh-client-ui-settings-commands'
```

The shipped web app mounts it after the Plugins section. The Host-side namespace is registered by `@deepseek-ai/dsh-command-prompt-config` under `prompt-commands`; the two packages share the namespace name but own no runtime dependency on each other.

## Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: section slot registration over the `prompt-commands` scope |
| [`src/client/controller.ts`](src/client/controller.ts) | Section model: draft normalization and whole-list writes |
| [`src/client/PromptCommandsSection.tsx`](src/client/PromptCommandsSection.tsx) | List, editor, and delete-confirmation surfaces |
| [`src/client/PromptCommandEditor.tsx`](src/client/PromptCommandEditor.tsx) | Add/edit form |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: empty |

## Known Limitations and Deferred Work

- **No drag reorder** — commands keep configuration order; reordering is a future enhancement.
- **Whole-list writes** — every confirmed change commits the entire list as one atomic write, which is correct but not minimal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
