# 030 — Isolated Ensemble social resolution

Status: proposed. Depends on [010](010_state_and_views.md) and [020](020_world_authoring.md). Select the standalone Ensemble core assessed in [013](../platform/013_life_engine_research.md), not its desktop application. Adoption is conditional on full checkpoint proof and reviewed distribution notices.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-runtime/src/life/social/port.ts`, `ensemble.ts`, `worker.ts`, `checkpoint.ts` | QA-only probe → typed production adapter, isolated worker, bounded calls and complete checkpoint |
| NEW `packages/lina-runtime/vendor/ensemble/` | Pinned minimal source modules with provenance manifest, original license and local patches; no upstream app/dependency install scripts |
| MODIFY root `NOTICE`, package `packages/lina-runtime/package.json`, `scripts/ci/build.ts` if asset inclusion requires it | Record dependency attribution and package worker/vendor assets; verify installed layout |
| NEW `packages/lina-core/src/world/social.ts` | Validate supported predicates/actions/effects against world pack and candidate transaction |
| MODIFY core `world/life-types.ts`, `validation.ts` | Explicit engine/checkpoint/rules/random versions and effect validation |
| NEW runtime `test/life-social.test.ts`, `life-social-recovery.test.ts`; MODIFY `scripts/qa/life-social-engine-probe.ts` only for shared provenance checks | Prototype proof → production adapter behavior and future-choice restore |

Fields originate in compiled world-pack schema and `SocialIntent`; transport uses bounded JSON into the receiving worker realm; checkpoint serialization includes rule/action digests, full social history, schema, engine revision, simulation time, order inputs and RNG algorithm/state/draw index; strict reload rejects unknown/mismatched versions. The authoritative resolver consumes the full state; the actor never receives it.

## Contract diff

```ts
interface SocialEnginePort {
  resolve(input: {
    checkpoint: EngineCheckpoint;
    intent: SocialIntent;
    targetResponse: TargetResponse | null;
    rulePack: CompiledWorldPack;
  }, signal: AbortSignal): Promise<SocialResolution>;
}
// Return proposed effects + next checkpoint + decision trace.
// No store writes, publishing, persona mutation or provider access in this port.
```

Ensemble's `getActions()` may already encode the target's accept/reject branch. Do not expose those resolved actions as the initiator's candidate menu. Form intentions using actor-visible capabilities and known conditions; collect the target response using that target's perception; resolve against authoritative state afterward. Private target attitudes may legitimately change the actual outcome, but not pre-action descriptions/scores/error text visible to the initiator.

The action vocabulary is extensible. A model can propose a previously unnamed intention as a composition of supported primitives (move, attempt interaction, transfer permitted resource, reveal claim, pursue goal). Validate resources/roles/knowledge/constraints and resolve normally. An unknown primitive becomes a proposed world-pack extension, never executable code or a fabricated success. A failed attempt can become an observed experience without applying the intended successful effects.

Use deterministic ordering before random tie-breaking and an explicit versioned PRNG. Store the input digest and result receipt before accepting effects. Kill an over-budget worker and keep the step retryable without a partial commit. A Bun/Node VM alone is not a security sandbox; the worker has no runtime-provided credentials, network clients, tools or store handles. Only validated data crosses the port. Memory/time/action/recursion bounds are implementation limits recorded with results, separate from product cadence/spend settings.

Start from pinned revision `8b74bdec4ba2ef4e14795b7591df3b5d73f283e3`. The manifest identifies each included source/fixture file and local patch. Review BSD-4 attribution obligations against Lina's distribution before adding source; retain notices in packaged artifacts. If this blocks adoption, preserve `SocialEnginePort`, explain the incompatibility and choose a reviewed alternative, rather than quietly importing a different engine. No compatibility conclusion is implied by the prototype.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| Commit one resolution, terminate worker/process, reopen full checkpoint, ask for next action | Same candidate ordering, response branch, RNG draw count/state and next effects as uninterrupted control |
| Two worlds and two simultaneous proposals | No cross-world predicates/history/RNG; losing stale proposal leaves winner intact |
| Change only a private target attitude before actor intention | Actor-visible input/menu byte-identical; later authoritative outcome may differ |
| Previously unlisted intention composed of supported primitives | Validated attempt can resolve; not rejected merely because absent from a canned action list |
| Unknown primitive, invalid role, impossible transfer, malformed history/schema digest | Explicit rejection; no silent partial restore or invented effects |
| Infinite/oversized rule evaluation, cancellation, worker crash after result | Bounded termination; no accepted side effects; stored result reused where complete |
| Package/build outside checkout with only installed assets | Worker loads pinned bundle and notices; no dependency on a research checkout |

Tests listed above are future files. The existing probe proves directed closeness/history isolation only; it does not prove the first row. Prove every row before marking the production adapter ready. Runtime isolation and validated ports (E7) restrict application use; a compromised local host or edited vendored source remains a bypass. Update 013 evidence levels and `docs/VALIDATION.md` without treating simulator tests as model-quality evidence.
