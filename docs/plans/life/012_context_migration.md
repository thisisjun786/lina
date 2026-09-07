# 012 — First-unit context transport and activation boundary

Status: transport implemented locally for [010](010_state_and_views.md), 2026-09-07; independent review in progress. Uses the scope/stop contract in [011](011_state_contract.md). Installed runtime activation still requires 050.

## What the first unit closes

The first unit proves core state/projections, purpose-bound model request construction and safe native-context migration using isolated fixtures. Actual shared growth, ordinary LIFE recall, automatic memory collection of mixed episodes and configured fleet activation require the source-policy/identity coordination in [050](050_work_and_persona.md). They remain required product features, not permanently disabled features.

`memoryBackend: "disabled"` is not sufficient isolation: the current app can still construct persona reflection and external-context summaries, and tools can return old journal text. First-unit tests therefore compose the real Codex adapter with fake RPC and explicit fixture projections without attaching these collectors. `startPersistentApp` integration must refuse a LIFE/ordinary-sharing configuration unless all required guarded consumers are available. Existing ordinary apps without LIFE configuration keep their established behavior.

Do not implement this as a user-supplied `allowUnsafeLife` or readiness boolean. The production integration builder must construct the required source-aware services and bind their common policy version; that builder is completed in 050. First-unit tests exercise the adapter and core directly. A tool argument, environment flag or fixture cannot substitute for that production service composition.

## Exact production and consumer path

| Stage / path | Change to implement |
| --- | --- |
| Producer — `packages/lina-runtime/src/session-app.ts`, `world.ts` | Resolve immutable purpose/policy from trusted world binding before initialization; reject model-selected purpose/agent/world. Capture the pure persona refresh function returned during registration. |
| Lina-owned contract — `packages/lina-runtime/src/host.ts` | Add `SessionContextPolicy` and explicit bootstrap compiler hook to `SdkSessionOptions`; keep provider SDK types out. |
| First initialization — `packages/lina-runtime/src/session-engine.ts`; `session-app.ts` | Pass the same optional policy to `engine.initialize()` as to session construction. The app calls initialization before the adapter is created. |
| Second initialization — `packages/lina-codex/src/session.ts`, `index.ts` | `createCodexSession()` initializes again; validation/migration must be idempotent and use the identical supplied policy. Export updated own contracts. |
| Serialization/parser — `packages/lina-codex/src/identity.ts` | Explicit v1/v2 header parsing, bounded context transition journal records, strict purpose/policy/epoch validation and atomic transition writes. |
| Bootstrap consumer — `packages/lina-codex/src/session.ts` | Decide start/resume only after policy validation; initial instructions come from pure current persona compiler, not an observer/recall hook. |
| Turn/tool consumers — Codex `host.ts`, `session.ts`; runtime `world.ts`, `persona/hooks.ts` | Preserve compositional context handlers, use the correct view, enforce bound purpose at tool execution and before every request. |
| New-entry identity — `packages/lina-codex/src/events.ts`, `session.ts` | Include native epoch in new entry identity after cutover; preserve old journal IDs and all their references. |
| Test consumers — runtime `test/fake-session-engine.ts`, `session-app.test.ts`, world tests; Codex adapter/lifecycle/event/world tests | Update direct option builders and mocks as well as actual adapter construction. Missing policy is never treated as a proven safe LIFE context. |

The `SdkSessionOptions` addition remains optional for unchanged ordinary clients. Omission means the existing non-LIFE behavior, not permission to claim the new context guarantee. An explicit LIFE/shared-growth configuration requires an explicit known policy. Recognized existing v1 files are read as legacy; policy-driven migration occurs only when the explicit new contract is requested. Do not rotate all unrelated installed sessions merely because a new binary exists.

## Proposed transport delta

```ts
// Lina-owned types; format versions are independent of one another.
type SessionContextPolicy = Readonly<{
  purpose: "conversation" | "life";
  version: 1;
  agentId: string;
  worldId: string | null;
  bindingRevision: number;
  disclosureRevision: number;
  sourcePolicyVersion: number;
  scopeDigest: string;
}>;

// SdkSessionOptions additions:
contextPolicy?: SessionContextPolicy;
bootstrapInstructions?: () => string;
currentContextPolicy?: () => SessionContextPolicy;

// SessionEngine initialization signature:
initialize(sessionFile: string, workspace: string,
           policy?: SessionContextPolicy): SessionIdentity | Promise<SessionIdentity>;

// New v2 Codex header fields, in addition to retained Lina/native identity:
contextPolicy: SessionContextPolicy | null;
nativeEpoch: number;
contextTransition: null | {
  id: string;
  target: SessionContextPolicy;
  phase: "prepared" | "pending";
};
```

`null` policy is permitted only in recognized legacy migration state, never as an accepted explicit-policy native binding. The codec rejects unknown versions/purposes, unsafe/negative epoch, malformed transition IDs and contradictory pending/bound state. Existing parser behavior that normalizes malformed native fields to null/unverified must not apply to these new authority fields. Record prior native bindings in append-only metadata records; keep the header bounded by its existing read limit.

Policy versions, bound identities and authorization revisions are constructed by `session-app.ts`/trusted adapter callers from the accepted world binding and disclosure policy → persisted by the single identity writer → decoded by all header helpers → consumed by `initialize`, `inspect`, `read`, `markPending`, `commitThread`, start/resume selection, per-turn dispatch and tool registration/execution. Update all direct call sites; destructured/spread session options must forward policy too. Do not infer purpose or rights from agent name, world text, imported raw JSON or native thread name.

`scopeDigest` is derived from all preceding authorization fields with a canonical encoder; a caller cannot supply an arbitrary digest to claim compatibility. It excludes ordinary world event/state revisions, so everyday progress does not rotate a context. Changing the bound agent/world, binding revision, disclosure permission revision or source-policy version invalidates reuse even when purpose/version are unchanged. Unbind carries a new binding revision and null world, not the previous world's rights. Permission revisions are monotonic and never restored by reverting a display setting.

The runtime-owned `context-policy.ts` module supplies the strict policy codec/digest builder. `currentContextPolicy` is the trusted live reader used before turns and tool-result delivery; it is required when an explicit context policy is supplied and must initially agree with it. Neither a frozen options object nor a model argument can certify that permission is still current. Direct non-LIFE clients can omit both. The later production builder supplies this reader from its fenced world/persona owners. Tests supply a controlled reader and change it during an in-flight tool call to exercise revocation.

Persist actual native-context exposure as metadata receipts owned by `session.ts` and the runtime journal: native epoch, request ID, material/source references, exposure kind (shared growth or disclosed LIFE body), scope digest and delivery outcome. Write the planned exposure before sending context/tool results; a crash with unknown delivery is conservatively treated as exposed. A failed dispatch may clear the pending exposure only with positive evidence that nothing reached the model. Compacting, omitting a reference on the next request, or changing a developer instruction does not erase this exposure history. Trusted exposure receipts are not model-authored source claims.

Add an optional trusted `contextExposure` callback to `SdkSessionOptions`, with a source discriminator for a turn or named tool call and a typed list of material references/kinds. This callback reports the runtime's selected projection before transport delivery; it never copies authority from tool arguments or free-form result text. Explicit-policy construction requires this callback even when the result is an empty list. The adapter persists its receipts, restores them from metadata on reopen, and exposes read-only lineage for 050. Tool errors do not serialize these private material IDs into ordinary responses. The field path is runtime/fixture producer → SDK option → Codex transport receipt writer → strict metadata decoder → subsequent epoch/source-policy consumers; all are in the transport worker's assignment.

## Bootstrap versus per-turn instructions

`installPersona()` already returns a pure refresh function. The runtime can retain it during `register` and provide a bootstrap callback that reads current authored profile and permitted projection only. The adapter calls it **after registration and before `thread/start`**, so the initial thread gets the full persona rather than only a common base prompt. It must not call `host.beforeTurn()` here: that hook chain can invoke memory/summary/provider work.

For a compatible resume, validate policy before `thread/resume`. Use only the resume interface already supported by the code. Refresh changed instructions through the existing `thread/inject_items` developer-message path before the first `turn/start`. Failure to inject blocks the turn; do not pretend the old instructions were updated. References remain explicitly untrusted additional context. Updating a developer message or compacting a thread is not evidence that its prior event/secret inputs were removed.

Purpose does not itself select a new model. Current `conversationTurn()` selects the conversation role at bootstrap and per turn. This unit does not change model/provider fallback. Actual LIFE actor/director routing is 040's `model-port` work and must be separately validated.

## Native-context transition state machine

Retain Lina `sessionId`, `sessionFile`, durable journal and the entire `BotBinding`. Change only the native context binding and its epoch. The preserved journal is for authorized display/history; it is not automatically eligible for the new model's memory or archive reads.

1. Under the existing session/transcript owner leases, inspect the requested policy, stored header and native exposure receipts. Reuse requires the same trusted scope digest and proof that retained exposure is still permitted. A legacy/unclassified exposure or incompatible scope requires a clean context; absence of world text in visible history cannot prove that prior `additionalContext` was safe. Rebind, unbind and permission restriction use this same transition even when purpose/version match. Conservatively rotate on any authorization-scope change unless compatibility of all retained exposure is proven.
2. Reconcile the old bound native run and Lina request state. If an active or uncertain old request cannot be resolved, record attention and do not start a replacement conversation turn. Never interrupt unrelated Codex work as a shortcut.
3. Atomically record the prior binding in a metadata record and set the transition to `prepared`. Preserve all existing journal bytes/IDs. Use one identity-writer transaction/atomic replacement, not an independent header update and loose side file.
4. Persist `pending` before issuing one new `thread/start`, using pure bootstrap instructions and policy-scoped dynamic tools. This is a native context transition, not a new Lina conversation or image owner.
5. On success, atomically commit new native ID, incremented epoch, policy and transition-completed metadata. A restart now resumes only that committed native binding.
6. If response/commit is lost after dispatch, retain pending/uncertain state and do not issue another `thread/start`. Reconcile only with supported identity evidence; otherwise require attention. No guessed latest thread or invented upstream idempotency guarantee.

New native event IDs include the epoch so two threads with identical turn/item IDs cannot collide in the retained Lina journal. Legacy epoch 0 entries retain their exact original IDs. The chosen encoding is versioned and shared by live event conversion and history reconstruction; source quotes, notices and prior images continue referencing old IDs. Active-run and stale callback checks include the epoch so late old-thread events cannot mutate the new run.

Before each turn and each tool-result delivery, fetch the current trusted scope and revalidate it. Revocation during an in-flight request prevents further old-scope delivery and fences completion; the old epoch is retained for audit but cannot run another ordinary turn. Apply the existing pending/uncertainty procedure before starting a replacement. SourcePolicy for every later journal episode inherits still-retained native exposure, even if that episode made no new world read. A later clean epoch has its own empty exposure ledger; archived episodes retain their original lineage. This is required for 050 capture/recall decisions as well as native context reuse.

## Image and context integration from current dev

Remote `dev` at `cd74c89ea642735a9eeee9f63f88651b900a7bef` contains the image adapter while the world MVP branch contains the context-composition fix. `git merge-tree --write-tree --name-only HEAD origin/dev` produced candidate tree `ee8ebae483bdd02165af6482281caec31009c780` with exit 0/no textual conflicts. This did not merge a branch or validate combined runtime behavior.

Preserve image `jobs.json` and attachment manifest bindings exactly; they compare the full `BotBinding`. Keep request/call/job/artifact IDs, image URL session association, `deliveredEntryId` and `{jobId, terminalRevision}` notice markers. A delivered image remains delivered when the native epoch changes. A pending old image must not be regenerated or moved into a fabricated conversation. Existing `appendNotice` must continue finding prior notice receipts in the preserved journal.

The combined implementation must also retain `CodexHost.emit()` passing amended context between handlers and `beforeTurn()` collecting both memory and world references. Do not resolve image/world integration by discarding either hook set. Real semantic integration tests run on the combined code after B; merge-tree success is only a conflict check.

## 050 activation dependencies that cannot be bypassed

| Consumer | Required before installed LIFE sharing |
| --- | --- |
| `context/companion.ts`, `companion-queue.ts` | Trusted source policy at scan, retry and final apply; preserve ineligible pending/failed history. |
| `persona/native-preferences.ts`, `persona/reflection.ts` | No LIFE-derived user facts or duplicate LIFE growth from retained episodes; explicit authored locks and current profile revisions win. |
| `context/capture-scan.ts`, Honcho outbox/capture/client and `context/memory.ts` | Source policy survives enqueue/chunk/retry; unqualified remote recall is withheld. |
| Runtime `context/external.ts`, `context/coordinator.ts`; core `context/store.ts`, `context/schema.ts` | Summaries and working context retain source-policy unions and eligibility; old contaminated summaries cannot be injected into the clean thread. |
| `context/tools.ts`, `context/memory-query.ts` | Model-facing `lina_history_search`, `lina_context_expand` and secondary journal search obey source/disclosure policy; user-visible history preservation is not model access authorization. |
| `agents/persona.ts`, runtime `persona/hooks.ts` | Current permitted growth is a separate input from native dynamics; adaptable dimensions actually affect behavior, with identity anchors/locks preserved. |
| All persona-policy mutation and LIFE-acceptance entry points | One owner fence coordinates profile edits, reflection changes and LIFE acceptance, or the runtime refuses activation; two stores do not provide an atomic guarantee by themselves. |

Core `IdentityPolicySnapshot` tests prove supplied-policy validation. A live runtime must additionally prove it supplies current policy and fences competing writes. The unit does not mark this solved by a prompt sentence or an optional callback that some routes ignore.

## Verification matrix

| Test target / activation | Evidence required |
| --- | --- |
| NEW `packages/lina-codex/test/context-policy.test.ts`; recognized v1 file → requested v2 policy | Old journal bytes/entry IDs retained; one valid transition; unknown policy/version/epoch rejected before RPC |
| MODIFY Codex `test/adapter.test.ts`, `session-lifecycle.test.ts`; initialize twice and fail before/after thread acknowledgment | Idempotent local initialization; pending uncertainty produces zero replacement starts; a late old-epoch event cannot resurrect the run |
| MODIFY Codex `test/world-session.test.ts`; raw legacy context → clean binding → reopen | New native epoch used; no old secret/summary in any serialized request; same Lina binding/history |
| Allowed world-A recall → permission revoke, world-B rebind or unbind → next turn and restart | Same-purpose scope change triggers one clean native epoch; no resume/use of A's retained context, no old-scope tool result, stable Lina/image ownership |
| Recall followed by an ordinary turn with no new world tool; revoke while a result is in flight | Episode policy inherits existing native exposure; pending delivery is treated conservatively; stale result cannot enter the new epoch or eligible factual memory |
| MODIFY Codex `test/event-identity.test.ts`; two native epochs reuse turn/item IDs | Distinct new entries without rewriting old references; stable reconstruction after restart |
| MODIFY runtime `test/world-context.test.ts`, `world-app.test.ts`, `world-approval.test.ts` | Exact safe projection in fixture ordinary request; no ordinary raw world tool before 050; LIFE-bound allowed read needs no confirm approval, explicit native deny still wins |
| MODIFY runtime `test/persona-runtime.test.ts`; pure bootstrap compiler and instruction update failure | Complete authored identity at start; observer/recall calls zero; no turn dispatched after failed instructions update |
| MODIFY integrated runtime `test/image-app.test.ts`, `image-jobs.test.ts`, `image-store.test.ts` | Cutover retains bindings/assets/notice receipts; no extra generation or completion delivery after crash/reopen |
| MODIFY runtime `test/session-app.test.ts`; configured LIFE without ready consumers | Explicit unavailable integration before capture/observer/archive activity; ordinary non-LIFE configuration remains usable |
| 050 gate tests in `test/life-memory.test.ts` | Drive actual Companion/Honcho/archive paths and profile-edit races; fixture-only input tests cannot activate installed sharing |

Implemented coverage is in Codex `context-policy.test.ts` (23 cases), runtime `context-policy`, `world-app`, `life-context` and the combined `life-session` tests, alongside existing adapter/session/approval regressions. The native lane passed 112 tests/580 assertions; the combined accepted-state/persona/serialized-RPC/reopen tests passed 2 tests/46 assertions. Both are included in the root pass in [010](010_state_and_views.md). Bootstrap observers remain unused, actual policy changes rotate native epochs, and pending acknowledgment/exposure metadata survives reopen without blind replacement. Current-policy and exposure callbacks are required whenever an explicit policy is supplied.

Image test paths exist in the image-integrated `dev` source, not the current world checkout; do not report them run here. Existing world/approval/session 25-test evidence at the unchanged world revision is reusable. Future QA must record exact combined source revision, test activation and runtime/SQLite versions. A successful fake-RPC migration is not proof of the real server's behavior; live acceptance remains in 080 with an explicit provider budget.

## Handoff

010 remains one implementation unit with the 011/012 dependencies explicit. Prepare the storage/projection change and transport tests in non-overlapping slices only after B is authorized; the main owner integrates the real call chain. Keep the existing MVP PR separate and respect its merge hold. Refresh `dev`/parent heads before implementation; no new push/merge follows from this P artifact.

Runtime checks and scoped APIs are the final application layer (E7). Prompt labels/client hiding are guidance (E1); direct privileged access to DBs, journal files or remote accounts can bypass application policy. The design does not claim hostile-host secrecy or removal of bytes already delivered to a provider.
