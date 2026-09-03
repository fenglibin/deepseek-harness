---
description: "The deployment-wide response-language directive: how the row resolves the language the model writes user-visible prose in, for users changing it and maintainers adding a language."
kind: "package-reference"
---

# @deepseek-ai/dsh-response-language

English | [中文](README.zh.md)

## Summary

`dsh-response-language` names the language the model must write user-visible prose in. It registers one system-prompt section demanding that language and nothing else: it adds no tool, no service, and no durable state.

`auto` — the default — reads the Web GUI's stored language choice first, then the host process's own locale, and registers no section when neither names a language this row directs. Chinese hosts therefore get a Chinese-speaking agent without configuration, an English host changes nothing, and a French host is left alone rather than being told to answer in English. The directive is a prompt *section*, not a runtime context, so it survives `includeRuntimeContext: false` and reaches subagent children, whose assembly merges the global layer.

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

Mount this row wherever agents answer a person. The shipped `dsh-base` bundle already does; an overlay restates the row to pin a language or turn the directive off.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-response-language'
  config:
    language: auto
```

| Field | Default | Meaning |
|---|---|---|
| `language` | `'auto'` | `auto` follows the GUI language and then the host locale; `zh` pins Chinese; `en` pins English; `off` registers no section at all |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-response-language) is the exhaustive source for every accepted field and its JSDoc.

### Which signal wins

`auto` resolves in this order and stops at the first signal that names a language. A language with no shipped directive also stops the search rather than falling through to a later signal, so a GUI choice of English on a Chinese host wins and produces no section:

1. The `locale.preference` field of the Web GUI's settings section — the language picked in Settings → General. This is the only one of the two a person controls directly, and it is absent until someone picks a language explicitly.
2. The host process's own locale: `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the ICU default. This is how a Chinese macOS or Linux desktop reaches the model without anyone configuring anything.

A signal naming a language with no shipped directive — `fr`, `ja`, an unrecognized tag — resolves to no section. The model then follows the conversation's own language, which is the only honest instruction for a locale this row cannot name.

### When the section is absent

Because English is what the model reaches unaided, `en` and `off` both emit nothing; they differ in intent, and `en` is the pin a deployment records when it wants English regardless of host. `off` is the only way to suppress the section on a Chinese host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the row; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One `ctx.effect` registers one section whose `text` is a provider, not a string. The provider re-resolves at each assembly, so switching the GUI language mid-session changes the directive on the next step with no restart and no re-registration. The host process's locale is fixed for the process lifetime and is therefore sampled once at activation; the GUI language is a live setting and is read per assembly through the optional `settings` service.

The section is registered at `RESPONSE_LANGUAGE` (−950), immediately after the harness identity and before the checkout-source and Web-surface orientation, so the instruction stands at the top of the prompt beside the statements of identity it qualifies.

Empty text is how the row opts out: the prompt registry drops empty sections at render, so "no directive" needs no conditional registration and cannot leave a blank paragraph behind.

### Why the locale namespace is a literal

The `locale` settings namespace belongs to `dsh-client-locale`, a browser package whose host half registers the section. Importing that constant would give a host row a production dependency on the Web client and drag it into every composition, including headless ones. The namespace name is a protocol constant instead, and the read is tolerant by construction: `settings.get` returns `undefined` for a namespace nobody registered, which is the ordinary headless case.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, signal resolution, directive text, section registration |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the registry owns the section's disposal) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the row's contract is not enough: the registry it contributes to, the setting it reads, and the surface that writes it.

- [System-prompt subsystem](../../../docs/subsystems/system-prompt.md) — the section registry, central order allocation, and variable interpolation.
- [Client locale package](../../client/locale/README.md) — the `locale` settings namespace and the language selector that writes it.
- [Settings subsystem](../../../docs/subsystems/settings.md) — how a namespace is registered, resolved, and observed.
- [Context group map](../README.md) — sibling request-context packages.

-----

<a id="model-experience"></a>
## Model Experience

### Response-language directive

#### What the model sees

One section, present only when the resolved language has a shipped directive. It demands that language for everything a person reads and exempts the data the model must not rewrite.

##### Directive for `zh`

```markdown
Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads in Chinese — explanations, plans, progress updates, summaries, questions, and the prose of commit messages, reports, and documents you author. Keep code, shell commands, file paths, identifiers, tool names, JSON keys, URLs, and quoted user or tool output verbatim; translate only the prose around them.
```

#### Token effect

Fixed: one paragraph of roughly 80 tokens, present or absent for the whole session. It does not grow with the conversation.

#### KV Cache effect

Prefix-stable. The text is constant while the resolved language holds, so it neither invalidates an existing reusable prefix nor grows across steps. Switching the GUI language replaces this paragraph and invalidates the prefix from its position forward — a deliberate cost for a rare, user-initiated change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the directive does not reach. They are current package constraints, not a task backlog.

- **Two directed languages** — only `zh` ships a directive. Every other locale resolves to no section.
- **The GUI language is invisible until it is picked** — the browser-derived language a fresh page adopts is never persisted, so a Chinese browser on an English host resolves through the host environment alone until someone selects a language in Settings → General.
- **The `minimal` preset suppresses the section** — its persona is `complete: true`, and assembly restores a complete persona as the only section, discarding every other contribution including this one.
- **The host locale is sampled at activation** — changing `LANG` in a running process does not change the directive; the GUI language does, because it is read per assembly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Adding a language means one entry in the `DIRECTIVES` map in [`src/index.ts`](src/index.ts) plus the config-union entry: resolution, empty-text opt-out, and the tests are all driven off that map. A directive demands a language while leaving data verbatim; keep that split, because the exemption is what stops the model from translating identifiers, paths, and quoted output.

</details>
