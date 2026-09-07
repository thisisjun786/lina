# Minimal world engine

Date: 2026-09-07. Status: minimal implementation, opt-in runtime integration. No installed service or automatic simulation is enabled by this change.

This implements the first world-state slice of [the selected direction](011_world_engine_risuai.md). [Daily-life SNS and profile images](010_agent_daily_life_ideas.md) remain follow-up work. The implementation is original Lina code using existing SQLite and host contracts; it includes no copied or ported RisuAI implementation, scripts, cards or assets. RisuAI import compatibility is not claimed.

## Ownership decision

| Existing owner | Current connection |
| --- | --- |
| `lina-core/src/agents/store.ts` and `agents/persona.ts` | Own authored identity and persona dynamics. World storage receives agent IDs, never an editable persona store. |
| `lina-memory/src/engine/store.ts` | Owns source-linked conversational observations. World facts stay in the world database; they are not inserted as user/self observations. |
| `lina-codex/src/task-store.ts` | Owns actual Codex work. A fictional activity does not create a Codex task or prove that real work ran. |
| `lina-runtime/src/session-app.ts` | Composes an optional, agent-bound world context with the existing persona and conversation. The application owns the shared world's lifecycle. |

The new owner is `lina-core/src/world/`, exposed at its `index.ts` boundary. `WorldStore` follows the repository's SQLite store pattern and reuses `openCheckedDatabase` for file safety. It has no engine SDK, persona, memory, image or UI dependency. The runtime depends on this core boundary and the existing Lina host contract. No package dependency or default startup path changes.

The owner search covered `world`, `scene`, `Database`, `systemPrompt` and the persona/context/task owners above. There was no existing world-state owner to configure or extend. Putting events in each persona would duplicate shared facts, and putting them in conversational memory would lose their fictional scope. A separate core feature keeps those boundaries explicit without a new service or package.

## Authored definition and live state

`WorldDefinition` requires an explicit world ID, authored version, title, time unit, initial time, registered agent IDs, places, initial scenes/occupancy and scoped lore. Names and scene descriptions are caller-authored content. No world setting, location, timezone or simulation speed is selected by the engine. Test gardens and study rooms are synthetic fixtures only.

The definition is immutable within a world ID. Repeating `create` with the same definition returns current state; a changed definition/version conflicts. Definition upgrades and world-pack imports need a future migration contract. Live state has its own revision, simulation time, scene occupancy and accumulated facts. An agent occupies at most one scene and may be outside all scenes.

Simulation time is a nonnegative safe integer in the caller's named unit. It never derives from elapsed wall time. `acceptedAt` is a separate UTC wall-clock timestamp. Restart does not advance simulation time or produce catch-up events.

## Trusted application API

The exported store is an in-process application API, not an authenticated network endpoint or a model mutation tool. The caller must be authorized to manage that world and must persist the command key before an uncertain retry. Agent-facing callers use the bound runtime projection below.

| Method | Behavior |
| --- | --- |
| `new WorldStore(path, now?)` | Requires an explicit database path; `:memory:` is also supported. Opens/audits existing state. The optional clock supplies acceptance timestamps only. |
| `create(definition)` | Creates an immutable authored definition and revision-zero checkpoint, or returns the matching world's current state. |
| `snapshot(worldId)` | Returns detached, complete state for a trusted coordinator. It includes private knowledge and must not be handed to an agent/UI audience. |
| `snapshotAt(worldId, revision)` | Reconstructs detached state at an accepted revision, including revision zero. Lets a coordinator freeze an event's original scene after later events or restart. This full snapshot has the same private-data boundary as `snapshot`. |
| `preview(proposal)` | Pure transition preview against the current expected revision. No receipt, clock read, database write or external effect. |
| `accept(proposal)` | Atomically stores one accepted event and the resulting checkpoint. Returns `{ event, replayed }`. |
| `context(worldId, agentId, limits)` | Returns one detached, bounded `WorldContext` from a consistent database read. |
| `close()` | Releases this store connection; repeat calls are safe. |

`WorldProposal` supplies `worldId`, `idempotencyKey`, `expectedRevision`, `simulationTime`, `kind`, `sceneId`, `actorIds`, `audience`, `summary`, `facts` and `moves`. Accepted results add an ID, resulting revision, immutable definition version, wall-clock acceptance time and `origin: "fictional"`.

The following in-memory example uses arbitrary fixture choices, not application defaults. Import `WorldStore` from `packages/lina-core/src/world/index.ts` in the caller's source tree:

```ts
const world = new WorldStore(":memory:");
world.create({
  id: "example", version: 1, title: "Example", timeUnit: "step", initialTime: 0,
  agents: ["a", "b"],
  places: [{ id: "room", name: "Room", description: "An example place" }],
  scenes: [{ id: "scene", placeId: "room", description: "A meeting", occupants: ["a", "b"] }],
  lore: [],
});
const accepted = world.accept({
  worldId: "example", idempotencyKey: "event-1", expectedRevision: 0,
  simulationTime: 1, kind: "activity", sceneId: "scene",
  actorIds: ["a", "b"], audience: ["a", "b"], summary: "A bell rang",
  facts: [{ id: "bell", text: "The bell rang once", knownTo: ["a", "b"] }],
  moves: [{ agentId: "b", sceneId: null }],
});
const view = world.context("example", "a", { maxChars: 2000, maxFacts: 10, maxEvents: 5 });
const originalScene = world.snapshotAt("example", accepted.event.revision);
world.accept({
  worldId: "example", idempotencyKey: "tick-1", expectedRevision: 1,
  simulationTime: 2, kind: "tick", sceneId: null,
  actorIds: [], audience: [], summary: "", facts: [], moves: [],
});
world.close();
```

An `activity` needs a valid scene, a nonempty summary and actors who are present or explicitly arriving there. Moves may affect only actors, and each destination must exist or be `null` for leaving all scenes. A `tick` carries no actors, scene, audience, summary, facts or moves. It only advances or retains time; it does not invoke a model or run an event chain. Every call processes exactly one proposal.

The expected revision protects against concurrent writers. Event IDs are derived from world ID and accepted revision. A retry with the same world/key and unchanged full proposal returns the original event even when its expected revision is now old. Reusing that key with a changed proposal is an error. A different key with an old revision is an error. The engine cannot deduplicate two semantically similar stories submitted under different valid keys.

Zero-valued input numbers are normalized to `0` before storage/comparison, matching JSON persistence. This includes JavaScript/JSON `-0`; an unchanged valid command remains retryable after serialization.

## Knowledge, provenance and bounded context

Each authored or accepted fact has an explicit `knownTo` list. Every activity's audience must include its actors; fact recipients must be a subset of that event audience. Knowledge is granted by the trusted proposal, not inferred from a generated image or conversation. A move does not retroactively expose old scene events. Facts are append-only with unique IDs in this slice; corrections/retractions are deferred rather than silently overwriting history.

The agent projection contains only its current scene, visible facts and visible event summaries. It omits other scenes, private fact text, recipients of facts and the event's full payload. Scene descriptions and place details are visible to current occupants, so authors must keep secrets in scoped lore/facts. The trusted coordinator remains responsible for putting only audience-shareable content in an event summary. Revision and world time are common metadata, not secret activity metadata.

`WorldContextLimits` explicitly supplies `maxChars`, `maxFacts` and `maxEvents`. There are no product defaults. `maxChars` measures serialized JSON UTF-16 length, not tokens; the runtime's provenance instruction is additional. Whole records are included, facts in stored order and events newest first. Oversized records are omitted with `truncated: true`; an oversized scene can be omitted too. A budget too small for provenance fails. Hidden records do not set the truncation flag. The current selector is deterministic scoped retrieval, not keyword/regex/probability lore activation.

Engineering ceilings reject excessive input instead of silently truncating accepted state: 32,768 characters per text field, 4,096 items per input list, and 1,000,000 UTF-8 bytes per definition/proposal/expanded checkpoint. These are storage bounds, not image-generation spend or a daily activity allowance. A full checkpoint requires a future retention/migration decision. Startup audits all accepted events; no large-history performance target is claimed.

`AppOptions.world = { store, worldId, limits }` enables `installWorldContext` for the actual session bot ID. Every Codex `beforeTurn` emits `context`; that hook reads the current world and replaces old `lina-world-reference` blocks automatically. A read-only `lina_world_read` tool also reads fresh state and accepts no world/agent selectors. Invalid startup binding fails before session initialization; a failed later lookup/budget aborts context preparation, and tool failures use the existing failed-tool result. There is no stale-cache fallback.

The reference explicitly says it is fictional data, cannot change identity/permissions, and must not be stored as actual experience. CodexHost composes the world and existing memory/working-context hooks; both reach the adapter's `additionalContext`, outside authored instructions. Other hook semantics are preserved. No world option means no world hook or tool. The application closes its shared store after stopping consumers.

In confirmation mode, `lina_world_read` uses the same automatic-read approval policy as existing memory/context reads. Explicit native `ask`/`deny` still applies, and mutation tools still need approval. Execution-path tests check the registered tool through CodexHost and the actual execution/approval coordinator, not only its read implementation.

This is an application composition seam. Fleet configuration, HTTP mutation routes and UI activation are not added. The tests exercise the real Codex host adapter with local synthetic sessions; they do not establish how a paid model will narrate the scene or prevent every possible model hallucination.

## Recovery and side effects

`BEGIN IMMEDIATE` serializes write decisions. A SQLite transaction includes both the event receipt and checkpoint. WAL and full synchronous writes protect committed state; rollback leaves neither half accepted. Multiple processes on the same local database resolve against the latest committed revision. Unsupported ownership/schema versions, broken references and disagreement between checkpoint and replayed accepted events fail on reopen.

Startup scans every stored event row. It does not impose the historical-read upper bound, so corrupt SQLite integer revisions beyond JavaScript's supported range are rejected during opening. `snapshotAt` alone restricts its event scan to the requested revision.

Reopen reconstructs state for integrity checking from saved outcomes. It never rerolls choices, invokes providers, creates jobs, posts content or replays external actions. There is no world background timer. A busy/failed write is surfaced to the caller; any uncertain retry must reuse its original key and payload.

Opening a store uses a bounded SQLite busy timeout. Failed lock acquisition preserves the original lock error; cleanup does not replace it with a rollback error when no transaction began.

## Image, UI and memory handoffs

Types live in `lina-core/src/world/contracts.ts`; they define integration contracts only. This slice does not dispatch image work, save image receipts, render UI or publish a feed.

- **UI:** consume the agent-bound `WorldContext`, including `origin`, world revision and truncation. A private agent projection is not automatically publishable to a shared timeline. UI/network owners must bind the authenticated/configured viewer instead of accepting an arbitrary agent selector.
- **Image:** `WorldImageBrief` carries version, world/definition/event/revision IDs, stable request ID, intended audience, a captured scene, summary and caller-authorized appearance references with persona revisions. The jobs owner uses `snapshotAt(event.worldId, event.revision)` to freeze the accepted revision, checks every included detail against the intended audience, and persists the brief before dispatch. Reading a later current scene is not the original event's scene. Provider, model, budget and retry policy belong to the image/jobs owner and are absent here.
- **Image outcome:** `WorldImageReceipt` correlates request/world/event IDs with `succeeded`, `failed` or `unknown` and an asset reference. A failed/uncertain image does not roll back the world event. Consumers must reconcile an unknown external result before retrying; the store's event idempotency alone does not provide exactly-once image generation or publication.
- **Memory:** `WorldExperienceReference` carries fictional origin, world/agent/event/fact IDs and text for a future scoped adapter. The current durable world ledger itself supplies fictional continuity. Native conversational observations and external OpenViking/Honcho stores are not modified by accepting an event.

## Follow-up decisions

The initial setting, simulation time scale, degree of autonomy, schedules/catch-up policy, generation budget, feed audience and profile-image cadence remain undecided. Internal SNS, posts/replies, bounded agent exchanges, periodic avatars, world definition upgrades, fact corrections, object state, declarative triggers and world-pack import/export remain later slices. Real activity provenance must be handled by its actual execution owner. No external SNS account or publication is authorized by these contracts.

## Verification record

All fixtures use temporary SQLite paths and local fake engine sessions. No installed Lina home, private memory, provider, image account or daemon is used. Behavior tests were written before implementation: the first core run failed because the world module did not exist. Later regressions demonstrated blocked scene re-entry, excessive expanded checkpoints at creation, and shared initial/live scene references breaking recovery after a move. Each was fixed and the same tests passed. Historical snapshots were also tested before adding the API.

Core checks cover shared/private knowledge, detached preview, rejected mutations, duplicate keys, two connections, simultaneous writer processes, a killed writer after acceptance, forced failure between event insertion and checkpoint update, immutable definitions, quiet ticks, backwards time, capacity, corruption and schema rejection. Runtime checks cover the actual host boundary and persona preservation. The Codex adapter regressions first failed twice: context hooks received the original payload instead of the prior hook's messages, and `beforeTurn` retained only one recognized context block. Both now pass while non-context hook semantics remain unchanged.

Independent review reproduced signed-zero create/event retry conflicts and constructor cleanup masking a busy-lock error. Separate regression tests first failed with those exact errors. Normalization and transaction-aware cleanup fixed them; the core suite then passed 17 tests, including the real lock timeout. This timeout test waits for SQLite's result and uses no sleep-based synchronization.

Local verification on the working-tree candidate based on `dev` commit `e41ce13`, Bun 1.4.0:

The 21 changed TypeScript source/test files have content digest `0cb7f86203f0eb59558a043b6abb9692f683037a881668fda8b7c6129292c050` (SHA-256 over sorted repository-relative path, NUL, file bytes, NUL for each file). Documentation is excluded from this digest.

| Command/check | Result |
| --- | --- |
| `bun test packages/lina-core/test packages/lina-runtime/test packages/lina-codex/test` | Exit 0; 677 tests passed, 0 failed, 3,431 assertions |
| World-specific coverage within that run | 40 tests across `world.test.ts`, `world-recovery.test.ts`, `world-context.test.ts`, `world-app.test.ts`, `world-approval.test.ts`, `world-host.test.ts` and `world-session.test.ts` |
| `bun run typecheck` | Exit 0; root and browser TypeScript checks passed |
| `bun run lint` | Exit 0; 5 existing warnings and 1,381 informational diagnostics, no errors. The warning sites match the base: companion queue, native preferences, the existing session-engine guard and two CSS selectors. |
| `bun run ci:build` | Exit 0; actual web asset build and CLI paths smoke passed with no state writes |
| `bun run ci:validate` | Exit 0; workflows, setup action, issue forms and contribution links validated |
| Documentation example executed with Bun | Passed; visible bell fact, revision-one historical scene and post-move occupancy matched |
| Changed Markdown links / relative import graph | All local links resolved; 113 reachable TypeScript files, no cycles |
| `git diff --check` | Exit 0 |

`world-session.test.ts` captures actual `createCodexSession` RPC requests at a local fake server. It checks that `turn/start.additionalContext` carries the scoped world as `untrusted`, new events reach subsequent requests, authored developer instructions remain unchanged, and reopening both stores resumes the same thread with restored knowledge. It makes no paid model call.

Independent read-only review of the initial candidate reran 34 world tests (271 assertions, exit 0), verified signed-zero retry fixes and primary-error preservation, and checked the transport regression. An additional SQLite automatic-rollback probe confirmed that failed acceptance leaves no partial event and that the connection remains usable.

Subsequent owner review found two P2 gaps. The new approval-path test first reproduced `waiting_approval`; it now proves automatic read completion, unchanged approvals/world state and retained native ask/deny/mutation boundaries. Two real-database reopen tests first accepted corrupt event revisions `9007199254740992` and `9223372036854775807`; both now reject them at startup. The updated 40 world tests are included in the 677-test run above.

These are local source/adapter results. Hosted CI, live model narration, image generation, browser UI, deployment and large-history performance are outside this verification record.
