# Config-Driven Prompt Command Design

English | [中文](prompt-command-config-design.zh.md)

This document records the complete design of the "prompt command" feature: requirement alignment, decision rationale, and architecture and data flow, serving as the basis for implementation and acceptance. The "why" behind each decision and the rejected alternatives live in the corresponding Agent Note (`.agents/notes/implemented/feature/2026-09-03-prompt-command-kind.md`).

## 1. Background and motivation

The menu that `/` opens in the session input used to hold two parallel namespaces:

| | Command | Skill |
|---|---|---|
| Registration | `ctx.commands.register({ name, description, handler })` | `SKILL.md` file or `ctx.skills.register()` |
| Behavior | The `handler` executes directly and produces no model message | A `/name` hit injects the body text into the model context as an instruction |
| Code required | Yes (the handler is a JS function) | No (a plain Markdown file) |

The core need the user expressed is a capability "between the two": **shortcuts for everyday prompts** — they must be sent to the model to execute (like a Skill) while staying lightweight and easy to maintain (like a Command), and adding or removing one must **not require code changes**; ideally they are configured visually in Settings.

After alignment, three points are fixed: execution semantics are "sent to the LLM", the maintenance form is "lightweight configuration", and the landing spot is "a second kind inside command" rather than reusing skill.

## 2. Requirements

1. Introduce a second execution kind inside the existing command: **code commands** (`code`, current behavior) and **LLM-executed commands** (`prompt`, new).
2. `prompt` commands: after the user types `/name`, the configured prompt text is sent to the model as **one user message** (equivalent to the user typing that text themselves), and the model replies normally.
3. Commands support a **Chinese display name**: the `/` popup prefers the Chinese name and falls back to the English kebab name when absent.
4. **Config-driven**: the command's English name, Chinese name, and prompt text live in the configuration file; adding or removing a command does not change code.
5. **Settings UI**: supports add, delete, and edit; deletion requires **confirmation**; interaction polish matters.

## 3. Decision

### 3.1 Decision A: a discriminated split on `CommandDefinition`

The existing `CommandDefinition` gains `kind: 'code' | 'prompt'` (default `code`):

- `code` (existing, backward compatible): the `handler` executes directly.
- `prompt` (new): carries a `prompt` text and submits it to the model on execution.

Both kinds share the full existing infrastructure — the `/` menu, lifecycle logs (`command/run`/`command/done`), and scope shadowing — and differ only at the `execute()` branch. `CommandDefinition`/`CommandDescriptor` also gain an optional `title` field carrying the Chinese display name.

### 3.2 Decision B: prompt commands go out as a user message

When a `prompt` command executes, it calls `agent.followup(createUserMessage(...))`, submitting the prompt as one user message sourced from `command-invocation`. Any extra text the user typed (`/name <extra>`) is appended as a supplementary line after the prompt. The message is an ordinary user message and the model replies normally; `command/done` records `success` without text so the model reply is not double-rendered.

### 3.3 Decision C: the config stores both-language fields

Each config entry carries `name` (English kebab, the unique id), `title` (Chinese display name, optional), `description` (English description), `prompt` (the prompt body), and `hint` (optional input hint). The frontend displays `title ?? name` and does not consult the locale dictionary (commands are added and removed at runtime, so a hardcoded dictionary does not fit).

### 3.4 Decision D: go through the settings capability plus a settings UI

- **Reuse the settings capability** (Option A) rather than a standalone JSON file plus watcher.
- The config plugin registers the `prompt-commands` settings namespace; the `commands` block in `cordis.yml` composes the `base` layer and settings is the user layer.
- The settings UI supports **add, delete, and edit**; delete goes through `RiskConfirmation` for a **two-step confirmation** (only after the checkbox is accepted).

## 4. Architecture

### 4.1 The command kind (`packages/interaction/commands`)

- `CommandDefinition`: adds `kind`, `prompt`, and `title`; `handler` becomes optional (`code` requires it).
- `normalizeDefinition`: normalizes the kind and validates that `code`/`prompt` keep `handler`/`prompt` mutually exclusive.
- `execute()`: the `prompt` branch calls `executePrompt()` → `agent.followup`; the `code` branch takes the original handler path.
- `CommandDescriptor` passes `title` through; a new `command-invocation` message source joins `MessageSourceMap`.

### 4.2 The config-driven plugin (`packages/interaction/command-prompt-config`)

- Registers the `prompt-commands` settings namespace (schema: `{ commands: [...] }`).
- The `commands` block in `cordis.yml` is the `base`; when settings change, `scope.watch` dynamically re-registers commands; without settings it falls back to the static config.
- Uses `ctx.inject(['settings'], ...)` to keep settings optional.

### 4.3 The settings UI (`packages/client/ui-settings-commands`)

- Registers the `settings.section` slot (id `prompt-commands`) under the settings navigation.
- `PromptCommandsController`: binds the `prompt-commands` scope and submits the whole table.
- `PromptCommandsSection`: list plus add/edit entry points plus delete confirmation.
- `PromptCommandEditor`: the add/edit form (name/title/description/prompt/hint).

### 4.4 The frontend Chinese name (`ui-input-trigger` + `ui-commands`)

- `InputTriggerCandidate` gains `title`; `MenuView` renders `title ?? name`.
- `ui-commands`' `candidates()` passes `title` through.

## 5. Data flow

1. In the Settings "prompt commands" page the user adds/deletes/edits → the whole table writes to the `prompt-commands` settings namespace.
2. `command-prompt-config` observes the settings change → re-registers the matching `kind: 'prompt'` commands.
3. The user types `/` in the session → the popup lists commands (Chinese name first), including the prompt commands.
4. Selecting `/name` or pressing Enter → `commands.execute()` → `executePrompt()` → `agent.followup` sends the prompt to the model as a user message.
5. The model replies normally; the prompt body persists in `user/message` (source `command-invocation`).

## 6. Alternatives considered (rejected)

- **Reusing skill**: a skill carries the burden of frontmatter, `<skill_content>` wrapping, and catalog injection that a one-line prompt does not need; and the list is a flat user setting, not a layered provider directory.
- **A standalone prompt-command registry**: duplicates the `/` menu, lifecycle logs, and scope shadowing.
- **A standalone JSON file plus watcher**: settings already stores JSON documents with conflict fencing and redaction; another file would re-implement that.

## 7. Implementation checklist

- Command core: `packages/interaction/commands/src/{index,types}.ts`
- Frontend Chinese name: `packages/client/ui-input-trigger/src/{types,client/MenuView.tsx}`, `packages/client/ui-commands/src/client/service.ts`
- Config plugin: `packages/interaction/command-prompt-config/`
- Settings UI: `packages/client/ui-settings-commands/`
- Mounting: `packages/preset/agent-presets/presets/standard/agent.cordis.yml`, `packages/bundle/web-app/cordis.patch.yml`
