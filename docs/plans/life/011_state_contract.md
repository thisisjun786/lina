# 011 — First-unit storage and projection contract

Status: P detail for [010](010_state_and_views.md), 2026-09-07. Proposed behavior class: C4 because it changes durable schema and private-state consumers. This document is a design artifact; no production code or database was changed.

## Scope contract

| Field | This unit |
| --- | --- |
| Method / trigger | Satisfy the first unit of the approved-direction roadmap following the user's request to proceed with P. |
| Goal | One accepted state can contain an event, personal knowledge and learned attitudes; each reader gets its permitted view; replay/restart preserves the same result. |
| Non-goals | Authoring UI, installed-world activation, autonomous/model calls, social-engine import, work ingestion, SNS/image dispatch and live ordinary-memory migration. Those remain in their owning later units. |
| Verifier | Named red-test targets and activation matrix below; actual baseline commands in the evidence section only prove existing behavior. |
| Stop / artifact | P ends with 010–012 concrete contracts and source/verification mapping. B is a later phase; record here and in the roadmap, not a parallel plan tree. |
| Outcomes | Ready for A if the schema, read boundaries and dependencies are concrete; otherwise record the specific unresolved contract. No claim that future tests pass. |
| Escalation | Product setting/cadence/spend/publication decisions remain unset. An incompatible source/schema or need to expand live activation changes the plan before implementation. Any worker assignment names a disjoint write set; two failed independent attempts return the slice to the owner. |

The implementation checkout currently supplies the world MVP at `24f776b8fe9ce29351aa67292e5a2692f9b1ed2e`. Remote `dev` was read as `cd74c89ea642735a9eeee9f63f88651b900a7bef`, which includes the image-owner change. The world MVP is not yet in that base. Preserve the full roadmap; this document resolves the first unit's schema and behavior, not a new reduced product goal.

## Keep the existing event protocol stable

`WorldProposal.kind` remains exactly `activity | tick` in this unit. Retain `WorldDefinition`, `WorldEvent` JSON and existing IDs. Add the LIFE envelope as a separate immutable log keyed to the world event; do not spread LIFE fields into `eventProposal()`, which currently strips only the known world metadata and then rejects extra keys.

This avoids silently broadening every old caller. `WorldStore.accept()` stays available for worlds without LIFE state. On a LIFE-enabled world it rejects new legacy writes with `LIFE_COMMIT_REQUIRED`; the caller must use `acceptLife()`. A retry of an old pre-activation event may return its exact pre-activation receipt, but never reinterpret a LIFE commit as an ordinary one. `preview()` cannot authorize a write.

Field/enum scan already covered the declaration, `parseProposal`, `transition`, `readEvent`/`eventProposal`, `rebuild`, `context`, public exports, runtime world hook and world fixtures/tests. Arrays and spread-based consumers matter as well as comparisons. Future kinds from 020 must amend this map before implementation.

## Owned data types

New types live in `packages/lina-core/src/world/life-types.ts`. Validators/builders live in new `life-validation.ts`; keep existing MVP parsing in `validation.ts`. All JSON versions below are format versions, not user settings or a chosen engine version.

| Type | Required fields and interpretation |
| --- | --- |
| `LifeDefinition` | `version:1`, `worldId`, `revision`, authored numeric trait/attitude definitions and habit IDs, participant IDs, explicit projection policy. Numeric axes supply finite bounds/initial values; no product axes or scales are invented. |
| `LifeState` | `version:1`, `worldId`, `revision`, `worldRevision`, `definitionRevision`, `baseWorldRevision`, current claims/beliefs/experiences/traits/habits/directional attitudes, `checkpoint`. World state remains owned by the existing world row. |
| `LifeClaim` | Stable `id`, statement text, owning source event, privileged truth classification and disclosure policy. Truth classification is never an actor's automatic knowledge. |
| `AgentBelief` | `agentId`, typed `ClaimRef`, stance/confidence category, source experience IDs and supersession reference. Agent projection returns its belief, not the oracle's truth classification or hidden owners. |
| `AgentExperience` | Stable `id`, experiencer, event reference, channel `direct | observed | told | inferred`, claim references and simulation time. A told claim does not make the agent a witness. |
| `GrowthDelta` | Subject agent, authored axis/habit ID, previous/next value, evidence references. Relation entries explicitly name `fromAgentId` and `toAgentId`; the reverse relation is a different key. |
| `DisclosurePolicy` | Explicit knowers, permitted disclosures and publication subjects are separate lists; empty publication permission is valid. Agent identity itself is bound by runtime, not a caller-supplied tool selector. |
| `EngineCheckpoint` | `version:1`, engine ID/revision, rule digest, encoding version, data digest and bounded JSON data. `empty` is a valid initial engine variant; it cannot masquerade as a restored Ensemble checkpoint. |
| `WorldBinding` | Ordinary agent ID, selected world ID or null, monotonically increasing binding revision, projection-policy revision. One selected world per ordinary agent; alternate worlds are never summed. |
| `LifeInput` | `worldId`, stable source ID/revision/digest, typed source envelope and optional consumed LIFE revision. Only a trusted application producer can admit one; external work producers arrive in 050. |
| `SideEffectIntent` | Stable world/intent key, accepted LIFE revision, typed payload and digest. Initially `publication_candidate` with event reference only; it does not itself dispatch, post, generate or grant permission. |

Maps in serialized state use arrays with unique compound keys, not dynamically assigned object properties. All references resolve either to prior accepted state or to an item accepted in the same commit. Future-event references, duplicated experience IDs, unknown axes, unsupported enum values, non-finite values and invalid revisions reject before writes. Normalize signed zero and set-like ID ordering before hashing/comparing; preserve meaningful action/experience order. The existing `MAX_WORLD_BYTES` and item ceilings remain explicit storage limits, not schedules or generation budgets.

`ClaimRef` distinguishes `{kind:"world_fact", id}` from `{kind:"life_claim", id}`. Existing MVP facts retain their exact IDs and `knownTo` membership in actor projection; they are not silently copied into new claims or invented autobiographical experiences. A prepared LIFE baseline adds no inferred growth or expanded disclosure rights. A new belief may reference either validated source kind, while publication still requires its separate explicit policy.

## Proposed store surface

```ts
interface LifeCommit {
  version: 1;
  world: WorldProposal;
  expectedLifeRevision: number;
  definitionRevision: number;
  claims: LifeClaim[];
  beliefs: BeliefDelta[];
  experiences: AgentExperience[];
  growth: GrowthDelta[];
  checkpoint: EngineCheckpoint;
  consumedInputIds: string[];
  effects: SideEffectIntent[];
}

// Trusted application APIs; none is exposed directly as a model tool.
prepareLife(definition: LifeDefinition): LifeState;
lifeSnapshot(worldId: string): LifeState;
lifeSnapshotAt(worldId: string, lifeRevision: number): LifeState;
previewLife(commit: LifeCommit, identity: IdentityPolicySnapshot): LifePreview;
acceptLife(commit: LifeCommit, identity: IdentityPolicySnapshot): LifeReceipt;
admitLifeInput(input: LifeInput): AdmissionReceipt;
setWorldBinding(agentId: string, expectedRevision: number, selection: BindingSelection): WorldBinding;
```

These signatures are design sketches on `WorldStore`, not existing exported functions. `LifeReceipt` contains world/event/LIFE revision and normalized input digest, with a returned replay flag. It contains no provider receipt. `IdentityPolicySnapshot` is supplied by a trusted runtime adapter from the persona owner, contains profile revisions/evolution locks and is included in the accepted provenance; it is not taken from model output. Core tests use explicit fixtures for this input.

The core cannot atomically read a different AgentStore database. The runtime must serialize persona-policy edits and LIFE acceptance under the same owner fence before live integration, then revalidate revisions immediately before commit. Until 050 implements/tests that coordination, installed activation remains unavailable. Current authored locks/revision also gate the read projection, so stale historical growth cannot override a later user edit. Do not claim two independent database commits form one transaction.

`prepareLife()` validates the existing world and explicit authored definition, records an immutable baseline at the existing world revision, and creates LIFE revision 0 without inventing a past social history. Repetition with the same definition returns the baseline/current state; conflicting definition at the same revision rejects. Later authoring revisions belong to 020. It does not configure a fleet, start a timer or select a provider.

## v2 SQLite design

Keep `application_id = 0x4c575231`. Preserve both existing `worlds` and `world_events` table definitions exactly. New SQL below is the design target, exercised as actual SQLite in the first migration test. JSON is parsed and semantically validated in code as well as checked for validity in SQL.

```sql
CREATE TABLE world_definition_versions (
 world_id TEXT NOT NULL REFERENCES worlds(id), version INTEGER NOT NULL CHECK(version > 0),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 PRIMARY KEY(world_id, version)
) STRICT;
CREATE TABLE life_config (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision)
) STRICT;
CREATE TABLE life_states (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), life_revision INTEGER NOT NULL CHECK(life_revision >= 0),
 world_revision INTEGER NOT NULL CHECK(world_revision >= 0), config_revision INTEGER NOT NULL,
 base_world_revision INTEGER NOT NULL CHECK(base_world_revision >= 0),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 FOREIGN KEY(world_id, config_revision) REFERENCES life_config(world_id, revision)
) STRICT;
CREATE TABLE life_commits (
 world_id TEXT NOT NULL, life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 world_revision INTEGER NOT NULL CHECK(world_revision > 0), idempotency_key TEXT NOT NULL,
 input_digest TEXT NOT NULL, envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
 PRIMARY KEY(world_id, life_revision), UNIQUE(world_id, world_revision), UNIQUE(world_id, idempotency_key),
 FOREIGN KEY(world_id) REFERENCES life_states(world_id),
 FOREIGN KEY(world_id, world_revision) REFERENCES world_events(world_id, revision)
) STRICT;
CREATE TABLE life_inputs (
 world_id TEXT NOT NULL REFERENCES worlds(id), input_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision >= 0), payload_digest TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), consumed_life_revision INTEGER,
 PRIMARY KEY(world_id, input_id),
 FOREIGN KEY(world_id, consumed_life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE life_effects (
 world_id TEXT NOT NULL, intent_id TEXT NOT NULL, life_revision INTEGER NOT NULL,
 payload_digest TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 consumer_receipt_json TEXT CHECK(consumer_receipt_json IS NULL OR json_valid(consumer_receipt_json)),
 PRIMARY KEY(world_id, intent_id),
 FOREIGN KEY(world_id, life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE world_bindings (
 agent_id TEXT PRIMARY KEY, world_id TEXT REFERENCES worlds(id),
 revision INTEGER NOT NULL CHECK(revision >= 1), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
) STRICT;
```

`life_steps` is not created empty in this unit. Its lease/usage/model-receipt schema is implemented with its real producer and consumers in 040. `life_config` here is the versioned social definition/projection contract, not an invented operational cadence; 020/040 introduce separately versioned runtime configuration fields. Deleting worlds/config revisions with live references rejects. Log compaction is not implemented by dropping receipts or baseline evidence; capacity exhaustion rejects a new commit and preserves readable history.

## One acceptance transaction

1. Parse/detach/normalize all input before mutation; derive its digest using one canonical JSON encoder. Include the identity-policy snapshot and all effects/checkpoint data in replay comparison.
2. Start `BEGIN IMMEDIATE`. Check a previous LIFE receipt first. Same normalized input returns it; a changed payload under the same key rejects even if the current world has advanced.
3. Read world/LIFE/config revisions in this transaction. Require `worldRevision = baseWorldRevision + lifeRevision`; validate referenced input ownership/unconsumed status and the runtime-provided persona-policy revisions.
4. Apply pure world transition, then pure LIFE transition. A quiet tick may advance clock/checkpoint but cannot contain social/knowledge/growth changes or a publication intent in this unit. A later consolidation operation must explicitly define its event semantics rather than smuggle changes through `tick`.
5. Derive the event ID from world/revision. Insert the normal world event, LIFE envelope and checkpoint; update both state rows. Mark consumed inputs and insert effect intents in the same transaction.
6. Commit. Only after commit can an external consumer discover an effect intent. No model, filesystem import or remote API call is allowed inside this transaction.

Pure transition modules use a detached snapshot; failed preview cannot mutate live scene occupants, beliefs, checkpoint bytes or flags. `previewLife()` returns no durable receipt and consumes no accepted random state. Consumer acknowledgments use a separate compare/digest-checked API in their later owner unit; they cannot change the event or accepted result.

## Migration and recovery

Before changing v1, verify application ID, exact schema, foreign keys and **every** event row using the existing unbounded startup scan. Rebuild and compare the old snapshot. Do not let a revision filter hide `9007199254740992` or SQLite's maximum integer. A recognized clean empty DB can initialize directly to v2; unknown/non-empty/unowned DBs reject.

Within one constructor transaction, create recognized v2 tables, copy each initial definition into the version registry and update schema version last. No LIFE activation or world binding is created implicitly by migration. Old worlds have no `life_states` row until `prepareLife()` receives an explicit definition. After migration, audit both the unchanged world ledger and any present LIFE baseline/commit/checkpoint chain.

Rebuild LIFE revision 0 from its immutable baseline, then replay contiguous envelopes and verify the paired world event and config version at each step. Check row keys against JSON identities/digests, source/input references, foreign keys and the exact stored final snapshot. Reconstruct side-effect intent payloads and consumption markers from commits to detect missing/orphan/mutated rows; a mutable consumer acknowledgment is audited against the intent but never replayed as an external action. An unknown engine checkpoint is rejected on restoration, not silently reset to empty.

Injected failure at any migration/write boundary must leave a reopenable v1 or fully audited v2 database. Constructor failure preserves the original error, rolls back and closes owned handles. Keep the user's original file; no automatic reset/clean/retry through data deletion. An old binary cannot open v2; rollback is restoration of an offline pre-migration checkpoint, not binary downgrade alone.

## Four projection contracts

`views.ts` takes accepted state and an application-issued scope, not an arbitrary `isAdmin` flag from a tool request. Expose identity-bound closures from the runtime. Core author APIs remain trusted application APIs.

| View | Allowed result | Explicit omissions |
| --- | --- | --- |
| Author inspection | Accepted state and provenance for the authenticated world owner | No automatic use as actor/narrator/image input |
| `LifePerception` | Actor's visible current scene, its beliefs/experiences/goals and own known attitudes | Oracle truth flags, other agents' private reasons/attitudes, unauthorized old scenes, hidden metadata |
| `SharedPersonaView` | Bound world's allowed axis/habit values and the speaker's permitted attitudes using approved public labels | Event/secret/experience text, free-form rationale, private causes/IDs, another agent's score |
| `PublicationView` | Accepted event material authorized for the exact recipient plus current policy revision | Anything known only to the actor; revoked permissions; unpublished material from other recipients |

Filter **before** matching, budgets, counts, selection and serialization. Slice whole permitted records, include only public truncation metadata, and never let hidden items consume budget or change a public total. Use approved public schema labels; arbitrary model-written trait names are not shareable. Historical publication/image input uses the historical accepted snapshot while rechecking current disclosure permission. Core `snapshotAt()` itself is not a public view.

## Change and field map

| Exact file | Change |
| --- | --- |
| `packages/lina-core/src/world/life-types.ts` NEW | All domain/receipt/view types above. Keep public exports explicit. |
| `packages/lina-core/src/world/life-validation.ts` NEW | One normalized parser per envelope/view-scope/config; canonical JSON/digest; exhaustive variants and limits. |
| `packages/lina-core/src/world/life-transition.ts` NEW | Pure baseline, update, evidence/reference and identity-lock validation. No I/O. |
| `packages/lina-core/src/world/views.ts` NEW | Four projections, historical input/current permission composition and record budgets. |
| `packages/lina-core/src/world/migrations.ts` NEW; `schema.ts` MODIFY | Exact known v1/v2 detection, schema transaction, post-migration audit handoff; no new schema hash shortcut. |
| `packages/lina-core/src/world/store.ts` MODIFY | New APIs, atomic sidecar log, paired-world invariant, full startup/history replay, error preservation. |
| `packages/lina-core/src/world/index.ts` MODIFY | Export supported types/projection interfaces; no raw DB/third-party engine objects. |
| `packages/lina-core/src/world/types.ts`, `validation.ts`, `transition.ts`, `context.ts`, `contracts.ts` | Keep MVP behavior compatible; amend only imports/shared validation needed by the new boundary. No LIFE envelope fields are spread into legacy JSON. |

Creation → storage → restoration → consumers is complete for every added group: `prepareLife` creates config/baseline → config/state JSON → strict read/audit → transition/views; `acceptLife` creates commit/experience/growth/checkpoint → envelope/state/intent/input tables → replay/audit → views/receipt readers; `admitLifeInput` creates input → inbox row → strict reload → `acceptLife`; `setWorldBinding` creates selection → binding row → strict reload/current-agent check → runtime's bound growth view. The model may propose data but creates no authority, binding or consumer acknowledgment.

## Red tests and observable acceptance

Create these files in B; they are **not existing runnable tests**: `packages/lina-core/test/life-state.test.ts`, `life-migration.test.ts`, `life-views.test.ts`, `life-fixture.ts`. Existing world recovery helpers can be reused.

| Trigger in actual test | Required observation |
| --- | --- |
| Build old v1 DB from preserved SQL, write events, open new store | Identical old event JSON/IDs/world state; v2 schema; no implicit LIFE activation |
| Corrupt key/revision/config/checkpoint/intent/inbox marker independently | Startup refuses the specific invalid file before any model/query path; does not fix it destructively |
| Install fault trigger for each state/envelope/inbox/outbox write, remove trigger, reopen | No partial event, growth, consumed input or side effect; retry works once |
| Kill child writer immediately after an accepted receipt, reopen | Event/growth/checkpoint/intent match receipt; replay returns identical result |
| Two processes submit different keys at same revision | Exactly one succeeds; the loser preserves winner; same-key same-payload retry succeeds as replay |
| Same key after world advances, changed checkpoint/identity/effect/consumed IDs | Exact replay succeeds; any material payload change conflicts |
| Attempt legacy `accept` after LIFE activation; mutate preview result | Cannot bypass LIFE invariants; later real snapshot unchanged |
| Two worlds use same agent/claim names; change one ordinary binding | No mixed knowledge/growth; old binding is fenced; unbind emits no LIFE growth |
| Add private facts/reasons/labels then query same public scope under tight budget | Public output byte-identical, including counts/omissions; secret does not crowd out public records |
| A believes a false statement and B knows the truth | Each sees only its own belief; no oracle flag or B's belief leaks to A |
| Allowed growth versus manual/locked identity-policy snapshot | Allowed change has cause and visible projection; forbidden change rejects without mutating authored persona |
| Unknown JSON/engine version, malformed or overflowing numeric value | Reject before acceptance/restoration; no silent fallback/reset |

Baseline evidence reused from the unchanged world source: existing four-file world/core/approval/session command passed 25 tests at the same MVP revision. It observes the foundation only. New verifier target paths above are unimplemented and NOT RUN; B must first show failing tests, then passing tests.

P document check: extracted the SQL block above and the actual v1 `SCHEMA` from `world/schema.ts` into an isolated in-memory SQLite 3.46.1 database. SQL creation exited 0, created all 9 expected tables, and `PRAGMA foreign_key_check` returned no rows. The check directly reads this document and the old schema file. It validates DDL syntax/creation only; data migration, replay, TypeScript parsing and canonicalization still require the future tests.

## Integration and control limits

Runtime transport/enablement is specified in [012](012_context_migration.md). Core acceptance and scoped APIs are the final application controls (E7); prompt guidance is advisory (E1). A privileged process can call trusted APIs with fabricated authority or edit DB files; no host-compromise protection is claimed. Application-issued identity/policy and single-owner integration are necessary, not optional caller conventions. Current persona edits always dominate projection; original source documents remain unchanged.

At completion update 010, platform 012, `docs/CODEX_RUNTIME.md`, `docs/VALIDATION.md` and the planning index with the tested storage/reader behavior and its activation limit. Preserve 020–080 as required product work.
