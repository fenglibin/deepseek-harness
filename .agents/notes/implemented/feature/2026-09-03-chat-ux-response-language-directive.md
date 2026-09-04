# Agent Note: The `zh` response-language directive now forbids an English fallback

Status: implemented

English | [中文](2026-09-03-chat-ux-response-language-directive.zh.md)

## Problem

Users select `中文` under Settings → General → Language, the web GUI copy switches to Chinese, and yet the model still answers substantially in English — its reasoning in particular. The earlier pass over the language setting "did not take effect": the UI language and the model's output language are two different channels, and only one of them was moving.

## Decision

Strengthen the single `zh` directive in [`response-language`](../../../../packages/context/response-language/src/index.ts). The row already shipped a directive that names Chinese and keeps code / paths / quoted output verbatim; it lacked the two clauses that actually stop the model from drifting back to English mid-answer:

- an explicit "Do NOT switch to English" when reproducing identifiers, paths, commands, or quoted output, and
- a mirror clause that keeps the reply in Chinese even when the user writes in English.

Both are appended to the existing verbatim clause rather than replacing it, so the directive now says, in one sentence stream: write user-visible prose in Chinese, keep non-prose verbatim, never switch to English around the verbatim parts, and stay Chinese when the user writes English.

### Why this is the fix, not the write path

The change was scoped after tracing the whole chain end to end, because the same symptom (GUI says Chinese, output stays English) can also come from the locale preference never reaching the Host:

- **Read path is correct.** `localePreference(ctx)` reads `settings.get('locale').preference`, and the real `SettingsProvider.get(ns)` returns the namespace's resolved value object (`{ preference }`), exactly what the row's `section['preference']` expects. `response-language.spec.ts` already covers `zh`/`en`/`off`, GUI-over-environment precedence, and the no-settings / non-object-section fallbacks.
- **Plugin is mounted with the default.** `packages/bundle/base/cordis.patch.yml` mounts `response-language` with `language: auto`.
- **Write path reaches the Host on loopback.** The browser writes through `SettingsScopeController.mutate → ctx.remote.settings.mutate → SettingsController.mutate → ctx.settings`, and the settings base plugin picks `persistence = 'host'` (not `'memory'`) exactly when `ctx.remote.$host.isLoopback` is true. The user confirmed a loopback page.

With the read path, the write path, and the mounting all correct, the remaining explanation is the softness of the directive itself: a model asked in one short sentence to write Chinese, with no explicit prohibition, falls back to English — and reasoning in English pulls the surrounding prose with it.

## Alternatives considered

**Add an `en` directive as a positive control.** Rejected: out of the confirmed scope; the project ships only `zh` today, and the absence of an `en` directive is deliberate.

**Instrument the read path with a dev-trace log to audit which leg fails.** Not needed after the code-level audit: every leg reads and writes the same `locale` namespace and `preference` field, and the mounting plus loopback persistence are confirmed. The trace would only add observability the audit already answered.

**Force the reasoning language too.** Rejected: reasoning content is model-owned; the harness injects a system-prompt section, and no section wording can reliably dictate the internal thinking language. The strengthened directive governs user-visible prose, which is what a user reads.

## Consequences

A `zh` user now gets a directive that names Chinese, keeps non-prose verbatim, forbids an English fallback around it, and stays Chinese against English input. The directive is still one section at order `RESPONSE_LANGUAGE`, so it continues to survive `includeRuntimeContext: false` and to reach subagent children.

The cost is a longer system prompt (three added clauses), which is the intended trade against a stronger instruction. Reasoning language remains the model's own, so a user may still see English thinking even when the prose answer is Chinese.

## Testing

- `response-language.spec.ts` — `directiveText('zh')` now also asserts the directive contains `Do NOT switch to English` and `mirror their tone but keep your reply in Chinese`. The full file is 17 tests.
- `loader.spec.ts` — still renders the Chinese directive between the identity and the persona.
- The whole package passes 18/18. One test, `lets the stored GUI language outrank the host environment`, hard-codes the running host as `zh`; it passes under `LC_ALL=zh_CN.UTF-8` and is a pre-existing environment assumption, not a change this note introduces.
- No recorded-session snapshot embeds the old directive text (`translate only the prose around them` appears in no `snapshots/` expected output), so `test:snapshot` is unaffected.
- `tsc -b tsconfig.client.json` and `run-oxlint.ts` pass; the two `response-language` READMEs were updated to quote the same directive.

## Deferred

The two remaining items of the same UX pass stay separate: the changed-files list with accept/reject, and suppressing errors a retry already resolved.
