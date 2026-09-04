---
description: "Configuration-driven prompt shortcuts: register reusable /name slash commands whose prompt text is submitted to the model, with no per-command code."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-prompt-config

English | [中文](README.zh.md)

## Summary

`dsh-command-prompt-config` turns a validated list of prompt-command entries into `kind: 'prompt'` slash commands. Adding a reusable prompt shortcut — a frequently used instruction such as a code-review or summarization prompt — needs no code, only a configuration change. Each entry carries the command name, an optional localized title, a discovery description, and the prompt text that is submitted to the model as one user message on invocation. Choose it when you want lightweight, configuration-owned prompt shortcuts rather than a code-owned command handler or a full `SKILL.md` skill.

## Table of Contents

- [Use this package](#use-this-package)
- [Source map](#source-map)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Compose the plugin with a `commands` list. Every entry registers one `/name` command whose `prompt` text is submitted to the model as a user message carrying the `command-invocation` source; an optional `title` gives a localized display name, `description` is the discovery summary, and `hint` advertises free-form input so the composer claims the line for extra arguments (appended after the prompt text).

```yaml
- id: command-prompt-config
  name: '@deepseek-ai/dsh-command-prompt-config'
  config:
    commands:
      - name: code-review
        title: 代码审查
        description: review the current diff
        prompt: 请审查本次代码变更，重点关注正确性、可读性与边界情况。
        hint: '<补充要求>'
```

### Command behavior

| Input | Result |
|---|---|
| `/code-review` | Submits the configured `prompt` text to the model as one user message. |
| `/code-review 重点看性能` | Submits the `prompt` text followed by the extra argument as a follow-up line. |

The command does not render output itself: the model's reply flows through the ordinary turn path, and the prompt body is durable in the resulting `user/message` event (its source names the command).

### Compose it

The plugin injects the commands registry. A custom app mounts the registry owner plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-prompt-config
  name: '@deepseek-ai/dsh-command-prompt-config'
```

The shipped `standard` agent preset mounts this plugin with an empty `commands` list, so deployments opt in by editing the preset configuration.

## Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: prompt-command configuration schema and registration |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: empty (no runtime invariant — the command registry owns validation) |

## Known Limitations and Deferred Work

- **Prompt text only** — entries carry static prompt text plus an optional free-form suffix; no template placeholders or parameter substitution.
- **No per-command images** — prompt entries do not declare image acceptance; a composer submission carrying images is refused.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
