# Agent Note: prompt-command kind and configuration-driven prompt shortcuts

Status: implemented

English | [中文](2026-09-03-prompt-command-kind.zh.md)

## Problem

Slash commands came in exactly one shape: a code-owned `handler` that executes directly against the receiving agent without producing a model message. Users also wanted lightweight, reusable prompt shortcuts — a frequently used instruction invoked as `/name` that IS submitted to the model, but without the ceremony of a full `SKILL.md` skill (frontmatter, `<skill_content>` framing, catalog injection). The two needs share the `/` menu and lifecycle logging but differ in what execution means, and the prompt-shortcut list had to stay user-editable without code changes.

## Decision

- `CommandDefinition` gains a `kind: 'code' | 'prompt'` discriminant (default `code`). A `code` command runs its `handler` directly; a `prompt` command submits its `prompt` text to the model as one user message carrying the `command-invocation` message source, with any extra argument text appended as a follow-up line. `CommandDescriptor` gains an optional `title` for a localized display name; the `/` menu renders `title ?? name`.
- `@deepseek-ai/dsh-command-prompt-config` registers the `prompt-commands` settings namespace (schema: a `commands` list). The cordis.yml `commands` entry is the composition `base`; when a settings provider is composed, the section becomes user-editable and the plugin re-registers the matching commands on every change; otherwise the static entry stands.
- `@deepseek-ai/dsh-client-ui-settings-commands` adds the Prompt Commands settings page: add/edit through a staged editor, delete through an in-page risk confirmation, each confirmed change committed as one whole-list write.

## Alternatives considered

- **Skill reuse** — model skills already load `/name` gestures and inject the body into the model. Rejected because skills carry framing, catalog, and frontmatter weight that a one-line prompt shortcut does not need, and because the prompt-shortcut list is a flat user setting, not a layered provider catalog.
- **A separate prompt-command registry** — a parallel registry keeps `command` closed. Rejected: it duplicates the `/` menu, lifecycle logging, and scope shadowing for no benefit once `kind` is a discriminant.
- **A standalone JSON file plus a watcher** — closer to the literal "one JSON file" request. Rejected: the settings seam already stores a JSON document, owns conflict fencing and redaction, and is what the settings page edits; a second file would re-implement that.

## Consequences

- One `/` menu now serves code commands and prompt shortcuts under one registry, one lifecycle (`command/run`/`command/done`), and one settings page.
- Prompt shortcuts are configuration-owned end to end: cordis.yml for deployment defaults, the `prompt-commands` settings section for user overrides, no per-command code.
- `command-invocation` is a new message source, so a prompt submission stays reconstructable from the session log.
