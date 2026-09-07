# LINA world engine: RisuAI reference and adoption backlog

Date: 2026-09-07. Status: world-engine direction and RisuAI reference selected by
the user. The [minimal world implementation](012_world_engine_mvp.md) now supplies opt-in state, events and scoped context; RisuAI imports and the broader mechanisms below remain backlog.
Related: [daily-life/SNS ideas](010_agent_daily_life_ideas.md),
[ima2 image engine](009_ima2_image_engine.md),
[refactor preparation](008_refactor_preparation.md).

## Product decision

Give LINA a world engine distinct from the persona engine. The user wants agents
to have ongoing everyday lives, periodic profile pictures and a Twitter-like SNS,
and selected RisuAI as a substantial source of reusable mechanisms and design.
Preserve the full direction: authored worlds, changing scenes, shared events and
multi-agent continuity, as well as contextual lore retrieval.

The setting, degree of simulation, time scale, posting cadence and initial world
are undecided. A contemporary shared living space is an example, not a selected
setting. The implemented minimum is documented separately; this reference does not enable a
world simulation or add features to the current ima2 implementation slice.

## Ownership and composition

| Owner | Owns | Provides to other components |
| --- | --- | --- |
| Persona | Authored identity, stable character traits, appearance anchors; existing ownership of dynamic mood and relationship state | An agent's perspective and response to an event |
| World | Authored places, rules and lore; simulation time, scene occupancy, objects and accepted world events | A consistent scene and the facts each participant can know |
| Memory | Durable experiences, corrections and provenance, with existing user/agent/world scopes | Relevant past experiences; distinct records for real activity and fictional scenes |
| LINA application/jobs | Coordination, authorized schedules, generation budgets, recovery and side effects | Validated event processing and durable jobs |
| ima2 | Visual generation using explicit provider/model selection | Images tied to scene, appearance references and accepted events |
| SNS/profile surfaces | Posts, replies, social interactions and avatar presentation | Views of accepted events and images, with their intended audience |

The application composes persona and world inputs. The world engine emits typed
events and scene context; it does not mutate persona internals, invoke image
providers directly or write to social feeds. Existing owners consume accepted
events through explicit application contracts. World relationship facts (for
example, membership in a fictional club) are distinct from persona-owned feelings
and learned relationship state; do not maintain two editable copies of either.

Structural alternatives considered: putting world state into each persona causes
shared events to disagree; keeping it only in generated posts cannot explain or
reliably reconstruct what happened. A separate world owner supports shared scenes
while preserving each agent's knowledge and perspective. It adds event/state
versioning and consistency work across persona, memory, jobs and SNS. Exact
package paths, implemented APIs and current limitations are recorded in the [minimal implementation](012_world_engine_mvp.md); no existing module is renamed by this document.

## Source evidence

Inspected upstream commit: `c454df882aaf32e02a22da26d3718c8cadc97814`, dated
2026-09-05T00:02:42Z; fetched from `main` on 2026-09-07. The GitHub tree response
was not truncated. The source paths below were read at that revision. This was
source inspection only: RisuAI was not installed or executed.

| Mechanism observed in RisuAI | Source at inspected revision | Proposed use in LINA |
| --- | --- | --- |
| Character/chat/module lore composition; keys, secondary keys, regex and always-active entries | [lorebook.svelte.ts:75](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L75), [schema:1320](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/storage/database.svelte.ts#L1320) | Load relevant world/place/person knowledge for a scene, filtered by audience and agent knowledge |
| Scan depth, recursive activation, probability, priority, evaluated-token budget and injection ordering | [lorebook.svelte.ts:488](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L488) | Bounded context selection with an explanation of why each item was included; record random choices for replay |
| Input/output/start/manual/display/request triggers, conditions, variable updates and effects | [triggers.ts:20](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L20), [runner:1058](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L1058) | Declarative scene rules and event reactions, with external actions dispatched by LINA jobs |
| Chat script state and default variables; CBS variable and conditional syntax | [database.svelte.ts:1817](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/storage/database.svelte.ts#L1817), [cbs.ts:793](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/cbs.ts#L793) | Typed, scoped world/scene state and controlled templates; preview evaluation should not change state |
| Mention-aware group ordering with per-character speaking probability | [group.ts:46](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/group.ts#L46) | A reference for selecting scene participants and responders; LINA also needs quiet turns, bounded exchanges and known participants |
| Modules containing lore, triggers, scripts and assets, enabled at several scopes | [modules.ts:19](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/modules.ts#L19), [composition:398](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/modules.ts#L398) | Versioned world packs with places, rules, lore and visual references |
| External lorebook conversion and character-card v2/v3 handling | [lorebook.svelte.ts:668](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L668), [characterCards.ts:721](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/characterCards.ts#L721) | Import existing setting material with a preview and explicit unsupported-field report; compatibility remains to be implemented and tested |

The inspected functions depend on Svelte stores, the selected character/chat,
RisuAI's database and parser; triggers additionally invoke its request/image/UI
facilities. They are not established here as a standalone world-engine library.
Extracting reusable code requires replacing those dependencies and verifying
behavior. The inspected group and trigger paths establish chat-oriented behavior,
not a durable autonomous everyday-life simulation.

## LINA additions beyond the inspected mechanisms

- **World definition versus live state:** version the authored rules and places
  separately from the current scene, attendance, objects and event history.
- **Time and event progression:** distinguish real timestamps from simulation time;
  support deliberate ticks, quiet periods and explicit catch-up behavior after
  downtime. Use the existing scheduling owner when implementation begins.
- **One accepted event, multiple perspectives:** commit a shared event once against
  an expected world revision, then supply only observable facts to each agent.
  Concurrent proposals must reconcile rather than silently overwrite one another.
- **Knowledge and provenance:** attach world/scene/actor IDs, origin and audience to
  events. A fictional cafe visit is not evidence of a real physical visit. Generated
  descriptions and images do not create real observations or overwrite authored
  identity. Preserve fictional continuity in its own memory scope.
- **Image and SNS continuity:** derive a scene brief from accepted events and
  appearance references. A failed image job does not roll back an unrelated world
  event; explicit jobs manage retry and publication state. Tie posts and avatars
  to their source event and asset so later conversation can reference them.
- **Bounded execution and restoration:** cap event chains and generation budgets;
  persist accepted choices/results and checkpoints. Restoring world state must not
  rerun billed generations, repost content or replay completed external actions.
- **Imported content boundary:** parse lore/cards as content with explicit scope.
  Inspect script and asset declarations separately; no implicit execution of
  imported JS/Lua, network requests or persona rewrites. Report unsupported syntax
  rather than claiming whole-RisuAI compatibility.

## Reuse and license record

The upstream [LICENSE](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/LICENSE)
is GPL version 3. Code reuse remains an option: identify the exact copied/adapted
files and revision, preserve notices, and account for GPL requirements for the
combined work and corresponding source when distributed. A separate package or
renamed files alone do not establish a license exemption. Determine the intended
LINA distribution/license arrangement before integrating a copied implementation.

This note records mechanisms and proposed contracts without copying implementation
code into LINA. For each future reuse item, record whether it is an independent
implementation, a port, or a separately integrated component. Character cards,
world text and artwork from third parties need their own source/license records;
the application repository's license does not establish permission for all content.

## Candidate implementation sequence and proof

1. After refactor, map the real persona, memory, context and job interfaces. Select
   concrete reuse files and the corresponding license/distribution treatment.
2. Build one authored world with two agents, one shared place, scoped lore and a
   persisted scene state. Prove the agents receive consistent facts but only their
   own permitted knowledge; prove persona identity is unchanged.
3. Run one deliberate event transition with conditions and a bounded context
   budget. Prove state survives restart, conflicting revisions are rejected,
   preview has no side effects and replay does not reroll accepted outcomes.
4. Generate an illustration via ima2 and create one internal feed post tied to that
   event. Verify the actual image in the feed and a later conversation that recalls
   the same fictional event without claiming it happened physically.
5. Add periodic activities/avatar updates, inter-agent replies and world-pack
   import/export. Verify a quiet tick, chain/budget limits, malformed imports,
   unsupported scripts, audience boundaries and recovery without duplicate posts.

This sequence records design candidates and acceptance targets, not test results or a committed
delivery schedule. The [minimal implementation record](012_world_engine_mvp.md) identifies the completed subset and its verification. Remaining mechanisms, schedules and publication need their own implementation and authorization.
