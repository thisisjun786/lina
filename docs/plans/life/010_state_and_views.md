# 010 — Accepted state, knowledge and shared growth

Status: implemented locally; independent review in progress. Parent: [whole plan](000_plan.md). Depends on the existing world ledger. Scope: one durable authority and explicit consumers; excludes scheduling and engine adoption. Installed activation remains gated on 050.

P concretization: [011 storage/projection contract](011_state_contract.md) and [012 context migration/activation contract](012_context_migration.md) own the exact first-unit design. They keep original world event JSON stable, specify the LIFE sidecar transaction and defer installed activation until the later memory/identity-owner gates exist. This preserves all requirements in 020–080.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| MODIFY public world exports; retain MVP `packages/lina-core/src/world/types.ts` event shapes | Existing event JSON stays stable; new LIFE sidecar envelope holds typed social, experience, knowledge and growth deltas |
| NEW `packages/lina-core/src/world/life-types.ts` | `LifeState`, `AgentExperience`, `KnowledgeClaim`, `SecretPolicy`, `GrowthState`, `LifeCommit`, `WorldBinding`, four view types |
| MODIFY `packages/lina-core/src/world/schema.ts`, NEW `migrations.ts` beside it | Exact v1 schema only → recognized v1→v2 transaction, immutable definition versions, versioned LIFE state/checkpoint and durable inbox/outbox; scheduler step receipts arrive in 040 |
| MODIFY `packages/lina-core/src/world/store.ts`, `transition.ts`, `validation.ts`, `index.ts` | World-only commit → validate and commit world event, social/knowledge/growth deltas, checkpoint, consumed inputs and publication intent together; public typed APIs only |
| NEW `packages/lina-core/src/world/views.ts` | Separate author inspection, agent perception, shareable growth and publication material; no caller-supplied authority bit |
| MODIFY `packages/lina-runtime/src/world.ts`, `session-app.ts`, `persona/hooks.ts` | Implicit raw world context → explicit use/policy-bound world access and shared growth option; remove stale legacy context items |
| MODIFY `packages/lina-codex/src/identity.ts`, `session.ts`; core `session-binding.ts` only if the shared binding shape changes | Persist conversation context-policy version and purpose in the Codex header, with strict migration; incompatible historical context starts a new native thread while retaining original history |
| NEW `packages/lina-core/test/life-state.test.ts`, `life-migration.test.ts`; MODIFY existing world tests | Real-file migration, rejection, all-or-nothing commit, scoped projections |
| MODIFY runtime `test/world-context.test.ts`, `world-app.test.ts`, `world-approval.test.ts`; Codex `test/world-session.test.ts` | Assert normal requests contain permitted growth but no event/secret fields; explicit LIFE reads retain correct approval behavior |

New records originate in typed builders/validated proposals, serialize into versioned JSON plus relational identity/revision keys in the world DB, decode with strict unknown-field/version/enum/numeric checks, and reach only `views.ts` consumers. Author inspection remains a trusted application API. This entire chain must exist before fields are considered supported.

## Contract diff

```ts
// Before: world?: { store, worldId, limits } injects full scoped reference.
// Conceptual access boundary: caller binds identity and purpose, never a model argument.
type WorldAccess =
  | { purpose: "conversation"; binding: WorldBinding; disclosure: DisclosurePolicy }
  | { purpose: "life"; binding: WorldBinding };
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
```

The implemented symbol bodies are defined in `life-types.ts`, with parsing in `life-validation.ts` and its focused record/state/JSON helpers. Runtime `WorldContextOptions` requires a current trusted context-policy reader and, for conversation, an identity-policy reader. `SharedPersonaView` contains world/agent/revision and allowlisted adaptive traits/habits plus the speaker's permitted attitudes. It excludes event text, secret text, private cause IDs, free-form summaries, other agents' attitudes and omniscient relation scores. The internal projection can retain audit references separately.

`AgentExperience` has experiencer, cause event, channel (direct/observed/told/inferred), claim references and simulation time. `KnowledgeClaim` distinguishes world fact from individual belief, with source, confidence category and correction/supersession links. Secret knowers, permission to disclose and publication audience are separate relations. Knowing something does not grant permission to publish it. Scene narration itself can be private; filtering facts alone is insufficient.

`GrowthState` holds authored-schema trait values, habits and directional attitudes with evidence history. Identity anchors and `AgentProfile.evolution === "manual"` block new adaptive changes; previous committed experience remains. Neither private cause text nor a model's arbitrary trait name may become shared personality. No per-world state is copied into existing `Dynamics.relationship`.

## Storage and compatibility

Keep one world SQLite owner. Add `world_definition_versions`, `life_states`, `life_commits`, `life_inputs`, `life_effects`, `world_bindings` and `life_config` with strict owner/version, keys scoped by world and validated foreign references; 011 specifies their SQL. Scheduler-owned `life_steps` comes with its real producer/consumers in 040. A `life_commit` identifies the corresponding world revision and checkpoint digest. Public MVP `accept()` on an activated LIFE world must use the same coordinator or reject, so old callers cannot bypass social invariants.

Migration validates the complete old ledger first, including numbers beyond JS safe integer range. It retains original event JSON/IDs and creates no LIFE history until explicit `prepareLife()` provides a definition and records a baseline at the current world revision. World events keep their format; new LIFE envelopes are independently versioned. Replay validates paired histories/checkpoints. No silent reassignment of historical knowledge. Interrupted migration rolls back; newer/unknown/corrupt databases are rejected without overwrite. Old binaries reject the newer schema, so rollback requires the pre-migration backup, not a binary-only downgrade.

World IDs and agent IDs are independent of task/thread IDs. Enforce one selected growth source per ordinary agent binding, with optimistic binding revision. Unbind clears the next prompt's growth without deleting history. World replacement does not blend personalities. Secrets must not enter diagnostics or user-memory adapters during validation errors.

Removing this turn's custom block cannot erase prior context retained by a resumed Codex thread. Record the context-policy version/purpose with the session binding. If an old thread previously received unrestricted world content and the engine cannot prove its removal, start a clean ordinary-context thread and retain the old conversation for authorized viewing; do not copy its contaminated summary into the new model context. The migration is explicit and idempotent. Normal conversation keeps its UI history without claiming the provider forgot prior input. Trace any provenance-bearing visible entries and summaries before reusing them for memory extraction.

The reuse key also includes trusted agent/world binding and disclosure-policy revisions, plus actual retained-exposure receipts as specified in 012. Same-purpose rebind/unbind/revocation cannot reuse a native context containing now-disallowed material. Subsequent source-policy classification inherits that native exposure until a clean epoch is committed.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| Inject failure after event insert, after social update, before outbox insert | Reopen actual DB: none of the proposed changes or consumed-input markers committed |
| Retry same commit; same key with changed payload; two concurrent writers | One event/growth/outbox; conflict for changed payload; stale writer preserves winner |
| Open v1 fixture, interrupted migration, unknown version, corrupt revision | Valid fixture migrates with unchanged history; all invalid cases reject without destructive recovery |
| Same secret in fact, scene, experience, relationship reason, error message | Non-knower and normal-chat serialized requests omit it and its private identifiers; authored admin view may inspect |
| Allowed trait changes; manual evolution; user persona edit; world unbind | Shared trait reaches next `turn/start`; locked change rejected; latest authored identity wins; unbound growth absent |
| Explicit disclosure request without grant versus granted purpose | No unrestricted `lina_world_read`; granted read is identity-bound and automatically allowed in confirm mode, native deny still wins |
| Existing raw world hook from resumed context | Old `lina-world-reference` block removed before a normal request, including thread resume |
| Native thread has prior raw world context that cannot be removed | Purpose/policy cutover creates one clean thread; original history retained for authorized viewing; no old private summary forwarded on restart |

The acceptance tests now exist in core `life-state`, `life-store`, `life-views`, `life-migration`; runtime `life-context`, `life-session`, `world-app`, `world-approval`; and Codex `context-policy`/existing regression suites. `life-session` composes accepted SQLite state, the actual persona compiler and actual serialized `turn/start` requests, then reopens the same Lina/native session. Historical direct/observed experience also checks the original event's actors/audience and time. No activity/tick variants were added. Future purpose values fail closed on decode.

First-unit source verification on 2026-09-07: root `bun test` passed 1,414 tests (6,846 assertions); root/browser typecheck, lint and `ci:build` passed. Lint retains existing nonblocking warnings/information. All data and native transports were synthetic and isolated. This is not evidence of live model behavior, installed memory safety, SNS, UI or image generation. [012](012_context_migration.md) preserves those later gates.

## Controls and residual limits

Storage validators plus purpose-bound read APIs are the final application layer (E7 runtime behavior). Prompt wording is guidance only (E1), not access enforcement. A local process with direct DB/filesystem access can bypass application rules; privileged world inspection is intentional. No protection against a compromised host is claimed. Shared attitude may indirectly suggest that something happened; the guarantee is scoped inputs and no private text/metadata export, not zero inference.

SoT updates at completion: `docs/CODEX_RUNTIME.md`, `docs/plans/platform/012_world_engine_mvp.md`, `docs/PLANNING.md`; include format/migration and new normal-chat boundary.
