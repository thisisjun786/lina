# 050 — Real work, shared persona and memory boundaries

Status: proposed. Depends on [010](010_state_and_views.md) and [040](040_autonomous_life.md). Scope: connect actual work to future LIFE behavior and shared growth to real conversation. Does not grant NPCs permission to start or mutate real work.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| MODIFY `packages/lina-codex/src/task-types.ts`, `task-schema.ts`, `task-store.ts`, `tasks.ts` | Turn completion updates status/notice → transaction also writes durable work receipt/outbox, queryable until acknowledged |
| NEW `packages/lina-runtime/src/life/work-bridge.ts` | No source integration → typed receipt subscription/poll, owner check, sharing policy, idempotent world inbox |
| MODIFY `packages/lina-runtime/src/fleet/codex-fleet.ts`, `fleet/task-routes.ts` | Wire task service receipts and explicit evidence/consent changes; no arbitrary model-authored success events |
| MODIFY `packages/lina-core/src/agents/persona.ts`, runtime `persona/hooks.ts`, `session-app.ts`, `fleet/manager.ts` | Existing dynamics/native preferences only → bounded `SharedPersonaView` alongside authored identity and real memory, refreshed at each turn |
| MODIFY core `protocol.ts`, `entries.ts`, `requests.ts`, `store.ts`; NEW core `source-policy.ts`; MODIFY Codex `session.ts`, runtime `session-app.ts`, `world.ts` | Trusted request/entry provenance created at the owning runtime boundary, journaled before settlement and restored with strict schema migration |
| MODIFY runtime `context/companion.ts`, `companion-queue.ts`, `capture-scan.ts`, `memory.ts`, `native.ts`, `persona/native-preferences.ts`, `persona/reflection.ts` | Gate actual native/Honcho collection, preference extraction, pending jobs, compaction and recall using journal provenance |
| MODIFY runtime `context/external.ts`, `coordinator.ts`, `tools.ts`, `memory-query.ts`; core `context/store.ts`, `context/schema.ts`, `entries.ts` | Preserve source-policy unions in LCM/working context and filter model-facing archive/search/expand paths; UI history remains independently available to its authorized viewer |
| MODIFY `packages/lina-memory/src/engine/types.ts`, `prompt.ts`, `validation.ts`, `store.ts`, `schema.ts`, `audit.ts`, `records.ts` | Source role/text only → trusted source policy lookup, persisted eligibility/provenance version, derived-record audit and query filtering |
| MODIFY memory `honcho/types.ts`, `outbox-schema.ts`, `outbox.ts`, `capture.ts`, `client.ts`, `messages.ts` | Retain source policy across chunking/outbox/retry and query scope; prevent legacy uncertain data from reentering normal context |
| NEW core `test/life-persona.test.ts`; Codex `test/task-work-receipts.test.ts`; runtime `test/life-work.test.ts`, `life-persona.test.ts`; MODIFY Codex `test/world-session.test.ts` | Task-store through world effect through real serialized next-turn request, restart and privacy negatives |
| NEW core `test/source-policy.test.ts`; memory `test/life-source-policy.test.ts`; runtime `test/life-memory.test.ts` | Actual Companion queue and Honcho capture/recall paths, legacy pending work and forged-source negatives |

New `WorkReceipt` fields are created only by the trusted task owner using stored task/turn revisions or explicit evidence records; serialized in a new `task_work_receipts` table within task-store transactions; strictly decoded by a typed TaskManager API; consumed by `work-bridge.ts`, then world input/director. Preserve `sourceTaskId`, `sourceTurnId`, receipt ID/revision, managing agent, verified participant IDs, outcome category, evidence references and permitted summary fields. Raw cwd/prompt/logs are not exported to LIFE.

## Contract diff

```ts
// Before: turn/completed -> status "idle" | "failed" | "interrupted" + notice.
// After: retain these task states; a separate receipt does not redefine idle.
interface WorkReceipt {
  id: string;
  taskId: string;
  turnId: string;
  taskRevision: number;
  receiptRevision: number;
  ownerAgentId: string;
  participantAgentIds: string[];
  outcome: "turn_ended" | "verified_result" | "failed" | "interrupted" | "corrected";
  evidenceRefs: WorkEvidenceRef[];
  sharedFields: SharedWorkFields;
  policyRevision: number;
}
// Task transaction -> source outbox -> world inbox -> source ack.
// One key identifies one receipt revision; replay never reapplies growth.
```

`turn/completed` currently maps a non-failed turn to `idle`; it is not task success. `verified_result` requires an explicit linked verifier/user confirmation record, including verifier identity and immutable evidence reference. A model claiming “tests passed” is reported evidence until independently established. Participant attribution needs actual task participation/handover records; do not infer collaboration from a mention. Unknown task statuses remain inspectable and cannot become success through a default branch.

Receipt creation must also cover terminal state discovered by `reconcile()`, not only live RPC notifications. Recovered completion uses the same task/turn identity. A source outbox in `tasks.sqlite` and an inbox in the world DB allow safe crash/retry without pretending both DBs share a transaction. Update strict task schema migration/version validation; reject unknown schemas and preserve old pending approvals/notices. Cursor-only polling of current task state is insufficient because it loses intermediate completions and corrections.

Source corrections/retractions create a new receipt referring to the old one. They revise future eligibility and add correction experiences; past fictional events remain history. Revoking share permission blocks future exports and withdraws applicable derived publications, without claiming to erase already viewed/downloaded material. Configure what task categories/fields may influence LIFE; absent sharing choices export no task content.

Persona composition preserves the complete authored identity and explicitly distinguishes adaptable traits from anchors. Both ordinary chat and LIFE read the same committed growth revision. Existing native memory mode must not suppress LIFE growth accidentally: `nativeDynamics` currently substitutes `emptyDynamics()`, so growth is a separate option, not hidden in that replaced object. `lina_persona_read(section: "growth")` returns only the safe projection; it must not expose internal growth cause records.

Change the prompt authority contract deliberately: the current `CORE_AUTHORITY` says learned data cannot change the core, and dynamics are used only gently. Keep the authored source intact, but compile stable identity/permissions/explicit user locks separately from initial adaptable temperament. Validated current traits/attitudes govern those adaptable dimensions, rather than becoming decorative background overridden by the initial personality sentence. Expose the precedence in `composePersonaPrompt` and use the identical rule in actor input. If an axis conflicts with an explicit authored lock, reject that growth; no free-form model rewrite of the source profile. Tests must show an allowed behavioral contrast as well as preserved anchors, not just presence of a new JSON field.

Explicit event recall first applies the caller's disclosure policy and labels returned content fictional. Ordinary memory capture cannot turn a fictional event, feed post or generated image into an observation about the user. Keep simulation records in the world store; if a memory adapter later indexes them, require a separate namespace/source type and lossless provenance. No generic append to native user observations. Compaction and resumed-thread context must retain the boundary.

## Memory source contract and migration

The actual native capture path is `CompanionMemory.scan()/process()` in `context/companion.ts`; the Honcho path is `capture-scan.ts` → `HonchoOutbox` → `CaptureDelivery`. Both presently select settled user/assistant text. `buildObservationPrompt()` currently reduces sources to entry ID/role/text, and `validateSources()` checks roles/quotes without a fiction boundary. A clean native thread alone cannot prevent the retained journal from being scanned again.

| Stage | Required field path |
| --- | --- |
| Create | Runtime resolves request purpose, current authorization scope and actual or possibly delivered LIFE/tool/material references, including still-retained exposure from prior turns in the same native epoch. Journal owner records `SourcePolicy {version, scope, requestId, contextReceiptIds, policyRevision, nativeEpoch, scopeDigest}` with scope `ordinary`, `life`, `mixed` or `unclassified_legacy`. Actor/SNS input is LIFE; an ordinary turn with retained disclosed event/secret material is mixed even without a new recall. Growth-only context is explicitly distinguished and does not itself taint a factual user message. Neither user/model JSON nor imported transcript `raw` can grant ordinary eligibility. |
| Persist | Core journal adds recognized request-source and entry-source policy tables; request context receipts and entry associations are durable before settlement/observer admission. Tool disclosure arriving mid-turn updates that request's policy before it can settle. Append/import APIs must provide trusted origin or receive unclassified status. Derived summaries retain the union of source policies. |
| Restore | Strict journal/queue/engine/outbox migrations preserve source IDs, historical failures and receipts. Decode policy versions with trusted lookup; absent/unknown/conflicting provenance is unclassified, never inferred ordinary from role. Old native headers/journals remain viewable. |
| Consume | Companion scan **and** process-time retry, native preference extraction, reflection, Honcho enqueue **and** dispatch, compaction, EngineStore apply/state/recall, known-slot prompts and ordinary runtime recall all check the same source policy. Models receive the permitted projection; final validators repeat trusted lookup and reject ineligible sources even if a model cites a valid quote. |

For first-party LIFE/mixed episodes, exclude the affected episode from automatic factual/native growth extraction; do not ask a model to strip fiction and then trust its label. This can withhold genuine preferences in a mixed episode: record that limitation and allow later independent ordinary user evidence rather than laundering the whole episode. Native self/relationship learning from actual conversation remains supported, but LIFE-derived growth cannot be duplicated into that independently editable engine. A purely ordinary user claim is still a claim, not independently verified physical truth; this policy does not solve all semantic fiction detection in arbitrary unmarked text.

Before processing old pending/running/failed jobs, re-resolve their source eligibility; preserve retry/error history and mark ineligible work withheld with a reason. Do not clear queues, count withheld work as successfully learned, or let one legacy entry fence all new eligible episodes. Existing memory records are audited against source lookup: ineligible/mixed/unknown-derived records are excluded from state, known slots and recall, with original history retained for inspection/correction. Rebuild from eligible sources into a new audited revision only when the source chain is provable. Eligibility changes invalidate recall/summary caches and stale observer results before apply.

Honcho chunks carry trusted source policy IDs/digests and a policy-versioned capture scope through the outbox. Recheck on delivery, including pending/unknown retry after restart. Already uploaded uncertain legacy content must not remain silently queryable as ordinary memory: if remote source-level filtering and proof cannot be established, withhold its recall and use a separately identified ordinary-only namespace after validation. Keep old remote data and disclose the recall limitation; no destructive remote cleanup is implied. `MemoryBridge.recall()` must reject unqualified scope/results and clear cached text, not accept arbitrary `result.text` merely because the service returned success. Remote API capability and migration cost are verified before enabling that path.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| Drive actual TaskManager `turn/completed` using fake RPC, then source/outbox/inbox APIs | Receipt exists durably; world opportunity changes using receipt, not a manually fabricated input |
| Completion learned during reconnect; repeat notice and outbox delivery | One receipt per source revision, one causal LIFE input; no lost terminal turn |
| Ended turn without verifier, failed task, unknown status, forged owner/evidence | No `verified_result`; invalid authority rejected; completion remains distinguishable |
| Crash after task commit / after world inbox commit / before source ack | Retry delivers once; evidence and task approval state survive migration |
| Correct/retract prior evidence or revoke sharing | Future candidate conditions update; explicit correction history, blocked publication; no rewritten old event |
| Commit a permitted habit/attitude, ordinary chat with native memory enabled | Exact next `turn/start` includes new shared fields; authored name/voice/anchors unchanged |
| Insert secret into growth rationale, persona-read result, compaction input, explicit recall without grant | Capture all serialized model/tool inputs: secret and private identifiers absent |
| Subsequent factual user-memory extraction after LIFE exposure | No fictional event/image promoted to supported user fact |
| Settle an explicit LIFE recall plus user reply, then run real Companion scan/process and restart | Episode policy survives; no factual/native-growth/preference update from the mixed episode; unrelated ordinary evidence still learns |
| Feed a valid fictional quote directly to EngineStore validation or forge an ordinary policy in user/model `raw` | Trusted source lookup rejects it; changing source metadata in content cannot grant eligibility |
| Existing pending/failed Companion jobs or Honcho chunks contain old LIFE text | Preserved queue history and visible withholding, zero observer/capture dispatch for ineligible work; new eligible entries progress |
| Existing contaminated engine record/known-slot/cache or unqualified remote recall | Absent from next memory prompt/tool response/ordinary turn; original evidence retained, no false successful migration |
| Old LIFE text exists in external summary, working context, `lina_history_search` or `lina_context_expand` result | Actual source-aware summary/query path excludes it before ranking/budget/output; preserved UI journal does not grant model access |
| Crash after context receipt, before entry association or settlement; downgrade eligibility while observer runs | Recover associations consistently; unclassified source cannot be admitted; stale result rejected at apply |
| A prior turn disclosed LIFE, then a turn has no new world tool, then permissions are revoked | Native exposure lineage still governs the second episode; revoked scope forces 012 context transition; old mixed episodes never become ordinary by relabeling |

These are future test paths. Existing task/persona regressions also run after changing their owners. The first-unit [012 activation contract](012_context_migration.md) requires this phase's source-aware service composition and coordinated identity-policy edits before installed sharing is enabled; disabling the memory backend alone does not satisfy it. A passing fixed-response request test proves delivery, not expressive quality; 080 checks actual later replies. Store/API validation is the application boundary (E7); source proof can still be wrong if the configured verifier lies, and privileged source editors can bypass it. Report that limitation, do not call an unverified summary proof. SoT: `docs/CODEX_RUNTIME.md`, `docs/VALIDATION.md` and planning index.
