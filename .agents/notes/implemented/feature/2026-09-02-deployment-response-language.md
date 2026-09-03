# Agent Note: The deployment names the language the model answers in

Status: implemented

English | [中文](2026-09-02-deployment-response-language.zh.md)

## Problem

On a Chinese desktop the Web GUI's own copy was already Chinese — `verify-client-ui-i18n` and dictionary parity have enforced that since the [locale-owned client UI copy decision](../architecture/2026-08-23-locale-owned-client-ui-copy.md) — but everything the page showed *during* a task was English. The assistant's prose, its plans and summaries, and every subagent report are model output, and nothing in the assembled system prompt ever named a language. The model fell back on the language of its prompt, which is English, so a Chinese user got a Chinese shell around an English agent.

Two facts made a naive fix wrong. First, the language a user sees is decided in the browser, and the only durable copy of it — `locale.preference` in the settings document — is written only when someone picks a language explicitly; the browser-derived language a fresh page adopts is deliberately provisional and never persisted. Second, the system prompt has several owners: the deployment persona lives in `dsh-system-prompt` config, and every shipped agent preset shadows it with a persona of its own, so text folded into the persona would not survive a preset.

## Decision

**One new host row, `dsh-response-language`, registers one prompt section naming the language.** It is a Consumer of `systemPrompt` and the optional `settings` service and defines no service of its own. The section sits at a new centrally allocated order `RESPONSE_LANGUAGE` (−950), immediately after the harness identity and before the checkout-source and Web-surface orientation, so the statement of language stands beside the statement of identity it qualifies.

**`auto` — the default — reads the GUI language first, then the host process's own locale.** The first signal that names a language decides, and the row ships directives for `zh` alone. An English GUI choice on a Chinese host therefore wins and produces no section, and a French host is left alone rather than being told to answer in English. The host signal reads `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the ICU default; `C` and `POSIX` are treated as naming no language. English resolves to no section because English is what the model reaches unaided, so the directory of shipped recorded snapshots needed no re-recording.

**The section is registered with a text provider, not a string, so the two signals are read at their own cadences.** The host process's locale is fixed for the process lifetime and is sampled once at activation; the GUI language is a live setting and is read at each assembly through `ctx.get('settings')`, so switching it takes effect on the next step with no restart. Registering no section when no directive applies is expressed as empty text, which the prompt registry drops at render — so "no directive" needs no conditional registration and cannot leave a blank paragraph behind.

**The `locale` settings namespace is read as a literal string, not imported.** The namespace belongs to `dsh-client-locale`, a browser package whose host half registers it. Importing the constant would give a host row a production dependency on the Web client and drag it into every composition, headless ones included. The read is tolerant by construction: `settings.get` returns `undefined` for a namespace nobody registered.

**Every recorded-snapshot composition and the Web e2e scaffold pin `language: en`.** Replays run with a per-run `DSH_HOME`, so a stored GUI preference cannot reach them, but `LANG` is inherited from the machine that runs the suite — and this repository is Chinese-first, so maintainers on Chinese desktops run it constantly. Without the pin, every committed `system-prompt.expected.md` would mismatch on those machines. The pin lives in the shared `default` composition every headless scenario layers on, in the eight SDK scenarios that own a composition of their own, in the two ACP record patches, in the two recorded SDK child compositions, and in the Web scaffold's hermetic patch list.

## Alternatives considered

**Fold the language sentence into the deployment persona.** Rejected: all four shipped presets mount `dsh-persona` and shadow `deployment:persona`, so the sentence would vanish for every ordinary session, and `minimal` restores its persona as the *complete* prompt. The language requirement is a property of the deployment, not of any agent's identity.

**Put the text in the Web app's `app:web-surface` section.** Rejected: the Web bundle is the browser surface, not the owner of language, and the section is suppressed by `surfaceContext: false` — which is exactly the configuration a non-interactive layer uses. The requirement is equally true of headless, ACP, and SDK sessions.

**Add a `responseLanguage` field to `dsh-system-prompt`'s own config.** Rejected: that package would then depend on the `locale` settings namespace and on host-environment detection, and it owns prompt *assembly* rather than any one deployment policy. A row of its own keeps the policy, its defaults, and its tests in one place and keeps `dsh-system-prompt` free of a settings dependency.

**Make the client persist the browser-derived locale so the host can read it.** Rejected as the mechanism for this change: it would make one browser's provisional detection durable for the whole DSH home, changing what "a fresh browser starts provisionally" means. The host environment covers that case without touching the locale package's semantics, and the explicit GUI choice still outranks it once it exists.

**Emit a directive for English too.** Rejected: it would make all 32 recorded system prompts machine-dependent on the recording host's locale for no behavioral gain, since English is already the model's default. Re-recording needs a live API key, so a hand-edit of those fixtures could drift from what the recorder would emit.

**Register the directive as a runtime context instead of a section.** Rejected: `suppressRuntimeContext` — which the `minimal` preset and the persona row can both invoke — discards contexts, and the instruction must survive it. Sections also propagate to subagent children, whose assembly merges the global layer.

## Consequences

A Chinese desktop now gets a Chinese-speaking agent with no configuration, in every profile: the row ships in `dsh-base`, so Web, headless, ACP, and SDK sessions all carry it. An English desktop is byte-for-byte unchanged, which is why no recorded fixture moved.

The trade-off is a prompt that depends on ambient state. Two deployment-varying inputs — a settings section and the process environment — now shape the model's request, so every replayed golden and the Web scaffold pin the language rather than inheriting the machine. A maintainer who adds a snapshot composition must pin it too, or accept a fixture that only passes on their own desktop.

The directive reaches everything a global section reaches and nothing a preset suppresses: `minimal` still gets no language instruction because its persona is the complete prompt, and a deployment that wants silence on a Chinese host sets `language: off`. Adding a language is one entry in the `DIRECTIVES` map plus its union member — resolution, the empty-text opt-out, and the tests all derive from that map.
