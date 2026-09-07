# 040 — Autonomous intentions, events and experience

Status: proposed. Depends on 010–030. Scope: a complete ongoing NPC loop, including durable scheduling and growth. Excludes feed publication and selecting the user's model, setting, cadence or spend.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-runtime/src/life/director.ts`, `actor.ts`, `runner.ts`, `scheduler.ts`, `model-port.ts` | Caller-authored MVP proposals → observed situations, free actor intention, target response, resolution and accepted step |
| NEW `packages/lina-core/src/world/experience.ts`, `growth.ts`, `events.ts` | Flat facts → personal experience, beliefs, goals/needs and persistent adaptive changes |
| MODIFY core `world/store.ts`, `life-types.ts`, `validation.ts`; runtime `life/config.ts` | Durable leased steps, input snapshots, bounded model receipts, reservations, usage reconciliation and cooldowns |
| MODIFY runtime `fleet/codex-fleet.ts`, `manager.ts`; `lina-codex/src/session.ts` only if isolation requires a new explicit option | One configured LIFE service; background model calls use Lina's Codex/OpenCodex ownership with no work tools |
| NEW core `test/life-experience.test.ts`, `life-growth.test.ts`; runtime `test/life-runner.test.ts`, `life-scheduler.test.ts`, `life-model.test.ts` | End-to-end deterministic steps, model request isolation, clock/lease/failure cases |

Field chain: validated actor goal/need + perception and pending input IDs → persisted step input/expected revisions and model request key → strict decoded model output, engine result and accepted commit → next director weighting, actor decision, shared growth and publication candidates. Model configuration is a reference to existing selected routes, not another provider catalog. Unknown intent types or model output fields fail validation.

## Contract diff

```text
Before: accept(callerWrittenProposal)
After:
  acquire(worldId, generation, expectedRevision)
  -> freeze inputs + reserve allowed usage
  -> select eligible situation OR quiet step
  -> actor observes and intends
  -> target observes attempt and responds
  -> social/world resolver proposes effects
  -> validate facts, experience, growth and disclosure
  -> atomic commit + checkpoint + durable publication intents
  -> reconcile usage and release lease
```

Event families encode eligibility, weight, participants, prerequisites and cooldowns. World constraints and active goals come first; novelty and recorded randomness choose among eligible situations. Prior work, unfinished goals and interaction history can alter opportunities. Quiet steps advance the selected simulation clock without fabricating activity. Do not inherit Neighborly's month length or 0.5 threshold as product rules.

Actor input contains identity anchors, adaptive traits, current needs/goals, permitted memories/beliefs, own relationship attitudes and observed opportunities. Model outputs include intended action and structured proposed rationale/effects, not authoritative state. The director can orchestrate a multi-actor encounter, but each actor/target receives a separate perception. No shared omniscient conversation thread. Background actors have no filesystem/actual-task/network tools merely because ordinary Lina has them.

Experience accumulates direct observations, disclosed claims, inferences and possible false beliefs. Successful/failed attempts, goal progress and repeated behavior can propose growth; consolidation validates evidence and configurable bounds before acceptance. A habit or attitude must change a subsequent decision or expression in tests. An explicit user edit/evolution lock takes precedence. Dreams, rumors and images remain fictional source kinds and cannot become user facts.

Scheduler state includes `generation`, `leaseOwner`, `leaseExpiresAt`, `nextDue`, configuration revision and last accepted step. CAS fencing on commit prevents an expired worker from acting after takeover. Wait for signals and injectable clock events in tests; never sleep to prove completion. Pause/disable/config change increments generation and invalidates pending commits. World simulation time and real scheduling time are independent. Offline catch-up is bounded and requires an explicit chosen policy; absence means no automatic missed-period replay.

Persist request/result status separately from accepted events. For a crash before dispatch, resume the same request; after dispatch with unknown response, reconcile using supported host evidence or mark `needs_attention`, never silently reroll. Completed response receipts are reused after restart. Retry count and model concurrency are bounded. Reservations cover actor/director/narration/image lanes separately; uncertain usage remains reserved until reconciled. Spend limits need price/usage evidence; if unavailable, enforce invocation/token limits and report monetary cost as unknown. Ordinary chat/work retain priority over LIFE background requests.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| Same checkpoint/rules/input/RNG/model receipts run twice | Same accepted event/experience/growth; one set of downstream intents |
| Change a known goal or prior experience, hold other inputs fixed | Candidate score/selection or actor decision changes with recorded reason |
| No eligible event, or newly invented but valid intention | Quiet time advances without post spam; new intention reaches resolver |
| Contradictory belief later corrected / intentional secret reveal | Each knower changes at its own observation boundary, with provenance; outsiders remain unaware |
| Per-step action chain limit, repetitive event, impossible scene action | Bounded stop/cooldown/rejection; no phantom movement or gained resources |
| Two schedulers; expired lease; pause during provider request | One winner, stale commit rejected, pause prevents new publication intents |
| Crash before/after model receipt; malformed output; unavailable selected model | Reuse complete receipt, hold uncertainty, reject invalid effects; no billing-route fallback |
| Missing config, budget exhaustion, unknown cost, reconnect after long absence | Explicit inactive/paused/attention states; no unbounded catch-up or silent spend |
| Real serialized background model request | Contains actor perception only; no secret of other actors or actual-task tools |

Future tests must drive each branch. Actual model quality is qualified in 080; fixed response tests establish mechanics only. Local process compromise can bypass scheduler controls; final application acceptance uses store revision/generation checks (E7), while model prompting is advisory (E1). SoT: `docs/CODEX_RUNTIME.md`, `docs/VALIDATION.md`, planning index.
