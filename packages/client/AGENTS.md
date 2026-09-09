# AGENTS.md — Web client stack

Rules for `packages/client/*` (the browser side of the dsh web GUI) plus its build entry `apps/web`. They supplement the repo-wide [conventions](../../AGENTS.md#约定) and the [package rules](../README.zh.md). Read the current [Web Client architecture](../../docs/subsystems/web-client.zh.md), [Slots reference](../../docs/subsystems/slots.zh.md), and [Conversation reference](../../docs/subsystems/conversation.zh.md) before changing the corresponding layer.

Packages here are named with the directory prefix: `@deepseek-ai/dsh-client-<name>`.

## Slot and props discipline

The [Slots reference](../../docs/subsystems/slots.zh.md) owns the current design; these are the rules you must not violate when writing or reviewing client code:

1. **One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? }, Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The shell alone renders `'root'`.
2. **children = declaration + authorization**: the slots your component renders are exactly the keys of your register call's `children` object (spec values: `kind`/`scope`). Rendering a slot you didn't declare, or declaring one someone else declared, fails at load — do not work around it; the conflict is the design speaking. Slot names mirror the composition path: `<domain>.<entry>.<hole>` (e.g. `'tool.call.toolview'`).
3. **Component props are the four shares, all derived**: `PropsRuntime<K>` (SlotMap: owner params + `useSession`/`sessionId` on session scope + global `useSessions`/`useWorkspaces`) & `PropsRenderSlots<S>` (children keys) & `PropsStore<H>` (store factory) & the inject face. Never hand-write a member a share already derives; never re-type a share locally.
4. **Hooks are framework-made only**: `useSession`, `useSessions`, `useWorkspaces`, `useStore`, `renderSlot` are the five standing seats, plus the `use<Name>` hooks the renderer binds from provide contributions and inject `hooks` compartments. Business code never creates a hook or selector as a prop value — pass plain data and callbacks. (Component-internal behavioral hooks that subscribe to nothing external are fine.)
5. **Live data has exactly three channels**: parent knows it → owner props at the renderSlot site; only the component knows it → local state; shared across entries or survives remounts → a store declared at register. Derived data is a pure function over framework-hook data (`useMemo`), never its own subscription.
6. **Stores: read `props.useStore`, write `props.actions.*`** — the declared actions are the complete mutation API. Write the store as an exported `createXXXStore()` factory (module-level handles are forbidden — de-facto singletons); share by passing one handle to several registers inside `apply`. Production code never calls the factory or `.create()` outside `apply`; tests do (that is the sanctioned zero-machinery path).
7. **inject returns plain data and callbacks** from the apply closure's own ctx — no hand-made hooks, no ReactNode producers, no whole-service objects. A registrant-private reactive fact uses the reserved `hooks` compartment (bare observables the renderer binds to `use<Name>`; components never see the sources). The plugin may use only the dependencies named by its `inject` declaration; there is no wider ctx to reach for.

## Reactive read discipline

1. **Everything a render reads that can change outside React arrives through a framework hook** (rule 4 above). Event-handler code may read live snapshots (e.g. `keyboard.snapshot`); render code subscribes.
2. **Business components contain no subscription machinery** — no `useSyncExternalStore`, no manual subscribe wiring, no mirroring an external snapshot into local state or a second store. Give each reactive fact its owning channel instead: registrant-private → the inject `hooks` compartment; cross-entry or remount-surviving → a declared store; per-session standard → `sessions.provide`.
3. **Data-access ladder** — resolve needs in this order: framework hooks (standing seats + provide/inject-bound `use<Name>`) → a declared store (`useStore`/`actions`) → inject callbacks → anything else is a new framework extension point and needs main-thread arbitration.
4. **UI domains share only JSON-compatible data and callbacks.** Route ReactNode content through a slot; do not add ReactNode-valued owner props or injected members.
5. **An observable source keeps two identities stable**: the source object itself (hook binding is cached per source), and its snapshot between changes (`getSnapshot` returns the same reference until the fact moves).
6. **Whoever rebuilds a published value republishes it through the same source in the same step**, and a registration path that can run after consumers exist notifies the live consumers as part of registering.

## ctx discipline (components never see ctx)

`ctx` belongs to the apply world only: the plugin body and the inject factories closed over it. Components — every `.tsx` under a feature domain — receive all data and callbacks **through the four props shares**; they never call a hook that reaches ctx, never import a service class to poke it, never read a React context (business components see zero contexts — `BindingContext` and its kin are renderer-internal). If a component needs something new, the answer is a prop threaded from its share's source (owner site, store declaration, or inject face), not a hook.

## Layering non-negotiables

The stack has one-way knowledge, documented in the [Web Client architecture](../../docs/subsystems/web-client.zh.md):

- **Business data lives in the object layer, never a store.** Entry-declared stores carry shared viewing/interaction state (selection, drafts, panel widths); sessions, frames, and connections stay in the object layer.
- **rpcId is strictly bidirectional**: the initiator mints, the responder echoes, and minting stays in Connection ([unary Remote migration](../../.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.zh.md)).
- **Notifier publication discipline**: `notifyNow` is only the direct echo of a user gesture; structural updates use microtask-batched `markDirty`, while visible streaming chunks use cumulative `markFrameDirty`. See `../api/session-controller/src/client/sessions/notifier.ts`.
- **The web layer is pure presentation.** Nothing that is only "how to draw" enters the session log. Tool cards derive in the Client from raw call/result events and persisted result metadata; process-local control state uses its own snapshots and frames. Unknown or malformed tool data falls back to the generic form. A new *model-visible* input still requires a session event (repo-wide rule).

## Directory regime (plugin packages)

One UI feature = one plugin package (`src/client/` browser half). A multi-domain package splits where its code could later become separate packages — ui-conversation is the example: `contract/` (the only shared API), domain directories that never import a sibling domain, and `apply.ts` as the single cross-domain assembly point; `scripts/verify-client-domain-graph.ts` enforces the levels. Registration goes through `slots.register` in `apply` — never module-level side effects.

## Moved to the subsystem docs

These are authoritative elsewhere and are not repeated here — read the target before working in that area:

| Topic | Where |
|---|---|
| Dependency declaration (npm sections, `dsh.client.external`, published payload) | [web-client.zh.md](../../docs/subsystems/web-client.zh.md) |
| Shared modules and the module graph (`PLATFORM_MODULES`, baseline externals) | [client-modules.zh.md](../../docs/subsystems/client-modules.zh.md) |
| New plugin package checklist and new component checklist | [web-client.zh.md](../../docs/subsystems/web-client.zh.md) |
| Push-time check ladder (`test:gui` / `test:web`) | [web-client.zh.md](../../docs/subsystems/web-client.zh.md) |
| Build-time browser environment (`DSH_CLIENT_*`) | [web-client.zh.md](../../docs/subsystems/web-client.zh.md) |
| Export discipline and package boundaries | [web-client.zh.md](../../docs/subsystems/web-client.zh.md) |
| Styling and localization | [docs/web-styling.zh.md](../../docs/web-styling.zh.md) |
| Testing and coverage (three tiers, jsdom pragma) | [docs/testing.zh.md](../../docs/testing.zh.md) |
| Conversation Node discipline | [conversation.zh.md](../../docs/subsystems/conversation.zh.md) |
