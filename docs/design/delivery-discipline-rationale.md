# Delivery Discipline Subsystem Design

English | [中文](delivery-discipline-rationale.zh.md)

> Status: decisions aligned, awaiting final confirmation (implementation on hold)
> Audience: maintainers and decision makers
> Related request: give every executed task a mandatory engineering flow — change records + design documents + openspec task splitting + verification and acceptance + post-execution self-check + programmatic gates + page presentation + configurability.

---

## 1. Background and motivation

DeepSeek Harness is a purely plugin-based Cordis agent harness. By default a model (LLM) executes tasks **freely and without constraints**: it can change code directly and declare "done" without producing any design, split, change record, or verification evidence. That creates three risks:

1. **Not traceable**: the task finishes, but "why it was done this way, what changed, whether the requirement is covered" leaves no trace.
2. **Not verifiable**: LLMs take shortcuts — they guarantee only "the code does not error", not "the feature is really correct at the business/requirement level". Pure prompt constraints ("please self-check") are unreliable, because an LLM can agree verbally without actually doing it.
3. **Not controllable**: large changes and small fixes travel the same free path, with no size-tiered mandatory flow and no configurable switch that lets token-rich and token-poor users each get what they need.

This design introduces an **engineering delivery discipline subsystem** on top of the harness, using "programmatic verification + configurable gates + visual presentation" to counter LLM shortcuts and force tasks through a closed loop of `design → split → implement → verify → accept → post self-check`. The core principle: **flow constraints must not depend on LLM self-discipline; they must be enforced by programs (state machine + validation scripts + external tools).**

---

## 2. Goals

- Establish traceable artifacts for every executed task (change records / design / split), written under the project working directory.
- Use **programmatic gates** so a task cannot skip a required phase or be wrongly marked "complete/accepted".
- Support **post-execution commands** once a task completes, driving further verification actions (deep self-check, full regression, `openspec validate`).
- Make every capability **configurable**: thresholds (how large a task must be to require a design or a split), switches (whether openspec is mandatory), and the post-hook command list, so users with different token budgets can tune it.
- Make the whole flow **visible**: each phase has a corresponding presentation in the UI, so the user perceives progress and gate status.
- Reuse the mature ecosystem (real openspec) instead of reinventing the wheel.

## 3. Non-goals

- Do not change `agent-loop` itself (following "Plugins, not loop changes").
- Do not reimplement a spec/task-split format — reuse openspec.
- Do not provide a cross-session/cross-project task database — tasks and artifacts are scoped to the project working directory, and in-session state lives in the session log.
- Do not own precise token/currency/time budgets (that is a separate policy layer, of the same kind as goal's round cap).
- Phase one does not gate subagents (subagent/workflow subtasks); by default only the root agent's tasks are constrained.

---

## 4. Current state

### 4.1 Reusable existing capabilities

| Capability | Package | Relation to this design |
|---|---|---|
| Persistent single goal | `dsh-goal` + `dsh-goal-round-driver` | Reference model for the task lifecycle; the round-cap continuation semantics overlap with "post-execution commands", so the boundary must be clarified |
| Plan mode | `dsh-plan-mode` | "guidance not enforcement" — a soft design-time reference, not a mandatory gate |
| Task list | `dsh-tool-todo` | Whole-list replace, single owner, too coarse for openspec splitting |
| Workflow orchestration | `dsh-workflow` | Subagent fan-out; usable for parallel lanes of "post verification" |
| User settings | `dsh-settings` + `dsh-settings-file` | Runtime configuration carrier for gate thresholds and switches |
| Session projection | `dsh-session-projection` | Strict replay; the carrier for page presentation |
| Runtime assertions | `ctx.invariants` | Strong foundation for programmatic verification |
| Workspace | `dsh-workspace` | Host-only project grouping, not model-facing, not a basis for artifact placement |

### 4.2 Key architectural constraints (they determine the skeleton)

1. **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log. Change/design/split artifacts are written to disk by the model through the `fs` tools, and **files on disk are not the session log**, so "how disk artifacts project into the log" must be designed.
2. **The enforcement philosophy is soft**: `plan-mode` is guidance, `guard/*` is advisory, and real enforcement comes from sandbox + approval. The "programmatic mandatory gate" this design wants is a **new paradigm**, but `tools/post-execute`'s `PostToolDecision` already supports blocking, and `agent/turn-stopping`, `agent/pre-step`, and `ctx.invariants` can all serve as enforcement points.
3. **The harness home is `~/.dsh`** (`dsh-home-paths`, overridable with `$DSH_HOME`). It shares the name but not the location with the project working directory's `.dsh`, so the two must be distinguished explicitly.
4. **A capability seam has three roles**: Service Definition / Provider / Consumer must all be present.

### 4.3 Findings from investigating real openspec

- The directory is fixed at **`openspec/` under the project root**; a custom root is not supported (no `spec-dir`/`root` config).
- Structure: `openspec/specs/<capability>/spec.md` (the formal spec) + `openspec/changes/<name>/` (active changes) + `openspec/changes/archive/` (archived).
- A change directory is **naturally four-in-one**: `proposal.md` (change intent) + `design.md` (technical design) + `tasks.md` (checkbox task list) + `specs/` (delta spec, `ADDED/MODIFIED/REMOVED/RENAMED Requirements`, `### Requirement` + `#### Scenario` + `SHALL/MUST`).
- CLI: `openspec init` / `list` / `validate [--strict]` / `archive` / `show` / `config`, and others.
- Config: `openspec/config.yaml` (`schema` / `context` / `rules` / `operations`).

**Conclusion**: once real openspec is adopted, the "change record, design document, task split" in the user request are already carried together by a single openspec change directory in the L2 large-task scenario, so `.dsh/` only needs to carry lightweight artifacts outside openspec. That is exactly the dividend of "reusing a mature capability".

---

## 5. Options considered

### Option A: a standalone "delivery discipline" capability seam (chosen)

Add a package family `packages/delivery/`, strictly following the three roles:

- **Service Definition**: delivery gate interface + phase state machine + config schema + `delivery/*` events.
- **Provider**: the default implementation, reading `.dsh/` and `openspec/` artifacts for programmatic verification plus a strict replay state machine over the session log.
- **Consumer**: model tools (record a change / write a design / write a split / submit for acceptance) + gate interception (`turn-stopping` soft + `pre-execute` hard) + client UI (projection + conversation node).

### Option B: compose existing capabilities plus a thin gate layer (rejected)

Reuse goal (task) + plan-mode (design) + tool-todo (split) + workflow (verification), adding only a guard plugin. Rejected because: `tool-todo` is whole-list replace and unsuited to openspec splitting; `plan-mode` is guidance and cannot enforce; forcing the semantics of all three would create heavy compatibility debt.

### Option C: MVP minimal layer first (rejected)

Do only "change record + post-execution command + self-check script". Rejected because: with no domain model, adding design/split later forces a refactor and costs more.

**Decision**: Option A, implemented in phases. Establish the seam and domain model first, then land features incrementally by batch.

---

## 6. The recommended design in detail

### 6.1 Domain model: delivery task and size tiers

Introduce a lightweight **DeliveryTask** work unit (anchoring what the user calls "every executed task") instead of reusing goal:

- **Unique id** (`Branded`), owned within the session.
- **Size tier** (decided by programmatic measures plus configured thresholds, see 6.4):

| Tier | Determination | Required phases | Artifacts |
|---|---|---|---|
| L0 small fix | below the design threshold | `created → implemented → verified → accepted` | one change record under `.dsh/changes/` |
| L1 larger requirement | ≥ design threshold, < openspec threshold | `created → designed → implemented → verified → accepted` | `.dsh/design/` design + `.dsh/changes/` change |
| L2 large requirement / non-small bug | ≥ openspec threshold, or a mandatory bug fix | `created → designed → specified → implemented → verified → accepted` | openspec change (proposal+design+tasks+specs) + `.dsh/changes/` change |

- **Phase state machine** (extensible; the merge-extensible default branch falls through `assertNever` on the closed set):

```text
created → designed → specified → implemented → verified → accepted
```

Transitions are **compare-and-set (CAS)**: before moving to a phase, the program verifies that the prerequisite artifacts exist and are valid, and refuses the write otherwise.

### 6.2 Directory layout (coordinating with openspec's native directory)

```text
<project>/                        # project working directory (cwd of the model's fs tools)
├── openspec/                     # real openspec (L2 tasks), using its native directory
│   ├── config.yaml
│   ├── specs/
│   └── changes/
│       ├── <change-name>/
│       │   ├── proposal.md
│       │   ├── design.md
│       │   ├── tasks.md
│       │   └── specs/
│       └── archive/
└── .dsh/                         # dsh's own delivery artifacts (L0/L1 tasks)
    ├── design/                   # L1 design documents
    └── changes/                  # change records for every task (including the L2 index)

~/.dsh/                           # harness home (general settings, already exists)
```

**Coordination note (confirmed)**: real openspec is fixed to the project-root `openspec/` directory and does not support a custom root. L2 tasks therefore use the project-root native `openspec/`, while `.dsh/` carries the lightweight artifacts outside openspec and keeps one index record per L2 task in `.dsh/changes/` pointing at the corresponding openspec change, so "every task has a change record" never comes up empty. The `.dsh/openspec` symlink option was rejected (poor cross-platform and git behavior).

### 6.3 Programmatic verification (belt and braces)

1. **Runtime state-machine gating (the main gate)**:
   - Use `ctx.invariants` to assert that a transition is legal (prerequisite artifacts exist, phase order is not skipped).
   - Use `agent/pre-step` / `agent/turn-stopping` for **soft reminders**: when a task is in a phase but its prerequisite artifacts are missing, inject a reminder context without vetoing model exploration.
   - Use `tools/pre-execute`'s `PostToolDecision` blocking for **hard interception**: block only the wrap-up action of marking a task completed/accepted (not exploratory tool calls, to avoid collateral damage).
2. **Post-execution commands (the rear gate)**: once a task completes, run the configured verification commands (for example `openspec validate --strict`, a custom deep self-check script, a full regression); only when all pass may the task enter `accepted`. If a post-hook fails, the task stays in `verified` and a fix instruction is injected back.

### 6.4 Config schema (configurable thresholds and switches)

Carried both by the `dsh-settings` namespace and cordis `config` (composition base plus runtime overrides):

```yaml
- name: '@deepseek-ai/dsh-delivery'
  config:
    enabled: true                    # master switch
    designThreshold:                 # size measures that trigger L1 (programmatic proxy)
      todoCount: 5                   #   number of todo items
      descriptionChars: 300          #   characters in the task description
      touchedFiles: 3                #   estimated number of files changed
    openspecThreshold:               # size measures that trigger L2
      todoCount: 15
      descriptionChars: 1200
    requireOpenspecForBugs: true     # whether non-small bug fixes force L2
    postHooks:                       # post-execution commands
      - 'openspec validate --strict'
      - 'pnpm run test'              # replaceable with a custom deep self-check
    enforcement: 'stateful'          # 'stateful' | 'advisory' | 'off'
```

- **On the size proxy**: before a task starts there is no reliable size signal, so programmatically measurable proxies (todo count, description length, number of touched files) drive a **heuristic tiering**, and the tier can be explicitly raised or lowered while the task runs (manual override by the model or the user), so a simple task is not misjudged as a complex flow.
- **`enforcement` tiers**: `off` is fully free; `advisory` only reminds and never blocks; `stateful` adds hard state-machine constraints plus soft boundary reminders (the default, confirmed).
- **Post-hooks can be overridden**: `postHooks` comes from the config baseline, and the user may append or override commands while a task runs; the task-level config wins.

### 6.5 Events and session-log projection

- Add durable session events such as `delivery/task-created`, `delivery/task-phase-changed`, and `delivery/artifact-written` (merged into `SessionEventMap` by declaration).
- **"How disk artifacts enter the log"**: when the model writes a file under `.dsh/` or `openspec/`, project a `delivery/artifact-written` event by listening to `fs/*` events (or by recognizing file-writing tool calls in `tools/post-execute`), so the gate state machine is reconstructable from the session log and "model-visible ⟺ logged" holds.
- Register a `delivery` session projection unit; the client view exposes the current task's tier, phase, artifact list, and gate status.

### 6.6 Page presentation (phased visualization)

- Add a `delivery` projection for clients to consume:
  - **Session sidebar/card**: an L0/L1/L2 tier badge for the current task plus a phase progress bar (created → … → accepted).
  - **Conversation node**: task creation, phase transitions, gate pass/failure, and post-hook results appear as collapsible nodes.
  - **Artifact view**: read-only previews of `.dsh/` and `openspec/` artifacts.
- Reuse `dsh-plan-mode`'s reviewed-exit presentation style; the "submit for acceptance" gate uses a similar review interaction.

### 6.7 Boundaries with existing capabilities

- Versus `goal`: a goal is "one long-lived objective in a single session with automatic continuation"; a DeliveryTask is "delivery discipline plus gates for one task". The two coexist: one goal can produce several DeliveryTasks in sequence. The "deep self-check" triggered by a post-hook is **one bounded verification**, not goal's unbounded continuation rounds.
- Versus `workflow`: if post-hooks need parallel verification lanes (for example reviewing several files in parallel), workflow can orchestrate them, but the default is a serial command list.

---

## 7. Implementation batches

Each batch is independently verifiable and rollback-able, and a config switch controls enablement.

| Batch | Content | Artifact | Acceptance signal |
|---|---|---|---|
| B1 | Package skeleton + DeliveryTask domain + state machine + `delivery/*` events + config schema + `.dsh/changes` change-record tool + gates (stateful/advisory tiers) | Change-record loop | An L0 task is forced to record a change, and the state machine refuses to skip phases |
| B2 | `.dsh/design` design-document tool + size tiering (proxy plus manual override) + designThreshold gate | L1 design loop | A larger task is forced to write a design |
| B3 | Real openspec integration (change create/validate/archive) + openspecThreshold gate + `openspec validate` wired into post-hooks | L2 split loop | A large task goes through the full openspec flow, and validate must be green before accepted |
| B4 | Post-hook framework (postHooks execution + failure re-injection) + deep self-check driver | Post self-check loop | Once a task completes, the configured commands run automatically and acceptance follows their result |
| B5 | Session projection + client UI (tier badge / phase progress / artifact preview / gate nodes) + config settings card | Visualization loop | The UI presents every phase and gate state completely |

---

## 8. Risks and rollback

| Risk | Impact | Mitigation |
|---|---|---|
| Mandatory gates hurt simple tasks | A simple fix is forced through a complex flow | Size-tier proxy + manual override + `enforcement` tiers |
| Projecting disk artifacts into the log breaks session-log purity | Violates an architectural constraint | Project `fs/*` events as durable events rather than having gates read disk directly for runtime decisions |
| Hard gates contradict the "guidance/enforcement separation" philosophy | Questioned by core maintainers | The default `stateful` blocks only "wrap-up actions" and does not veto exploration; the design document argues the case directly |
| The openspec directory conflicts with `.dsh/` | User confusion | The 6.2 coordination note plus a UI that distinguishes the two directories clearly |
| Token cost grows significantly | Design/split/verification multiply token use | Config switches + tiered thresholds, with L0 minimizing overhead |
| The size proxy is unreliable | Tier misjudgment | Manual raise/lower override + evolving the proxy's precision in phases |
| External dependency on the openspec CLI | L2 is unusable when the CLI is missing | The `openspecThreshold` switch plus a fail-loud message when the CLI is absent |

**Rollback**: each batch is independent and `enabled: false` turns the whole thing off; the package family mounts independently, so unloading removes the capability, `agent-loop` is untouched, and existing session event formats are not polluted (new `delivery/*` events carry `ignorable: true` semantics, so older builds can ignore them).

---

## 9. Confirmed decisions (decision log)

| # | Decision point | Conclusion |
|---|---|---|
| 1 | openspec directory location | The project-root native `openspec/` (not under `.dsh/`); `.dsh/changes/` keeps one index per L2 task pointing at the corresponding change |
| 2 | Task anchor | Add a `DeliveryTask` domain; do not reuse `goal` |
| 3 | Default gate strength | `stateful` (hard state-machine constraints plus soft boundary reminders) |
| 4 | Who runs post-execution commands | Once a task completes, the gate framework runs postHooks automatically and accepts based on the result; the user may append or override commands at runtime |

---

> Once this document is confirmed, implementation starts; each implementation batch lands its own `.agents/notes/` Agent Note and tests, following existing repository conventions.
