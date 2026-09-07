# 020 — User-authored worlds and declarative rules

Status: proposed. Depends on [010](010_state_and_views.md). Scope: authoring/validation/preview and version changes. Excludes choosing the user's setting, executing imported scripts or activating recurring spend.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-core/src/world/authoring.ts`, `rules.ts`, `lore.ts` | Flat places/lore only → versioned background, constraints, agent roles, predicate/trait schemas, event families and bounded declarative rules |
| MODIFY `packages/lina-core/src/world/validation.ts`, `store.ts`, `transition.ts` | Immutable initial definition only → immutable version registry plus explicit effective-version change event and historical replay |
| NEW `packages/lina-runtime/src/life/authoring.ts`, `config.ts`, `tools.ts` | No authoring service → draft from user text, report missing decisions, preview diff, confirm exact revision, expose bound tools |
| MODIFY `packages/lina-runtime/src/fleet/manager.ts`, `codex-fleet.ts`, `server.ts`; NEW `fleet/life-routes.ts` | No fleet world configuration → trusted authoring/config API and one service lifetime |
| NEW core `test/life-authoring.test.ts`, `life-lore.test.ts`, `life-rules.test.ts`; runtime `test/life-authoring.test.ts` | Draft lifecycle, hostile/unsupported import, version transition and config round trip |

Field chain: `WorldDraftInput` from user-controlled API/tool → validated `WorldPack` and draft revision stored with raw authored text → strict schema-version parser on reload → rule compiler, director, actor perception and preview UI. Scheduling/publication budgets are separate `LifeConfig`, not attributes guessed by the world-draft model. Every rule opcode is exhaustively parsed/validated/compiled/audited, with unknown opcodes reported as unsupported.

## Contract diff

```ts
// Before: WorldDefinition has one immutable version and flat lore.
interface WorldPack {
  schemaVersion: 1;
  worldId: string;
  version: number;
  background: { authoredText: string; era?: string; environment?: string };
  constraints: WorldConstraint[];
  places: WorldPlace[];
  agentRoles: WorldRole[];
  lore: LoreEntry[];
  predicates: PredicateDefinition[];
  traits: TraitDefinition[];
  rules: DeclarativeRule[];
  eventFamilies: EventFamily[];
  unresolved: AuthoringQuestion[];
}
// Proposed API: draft(input) -> preview(draftId, revision)
// -> activate(draftId, expectedRevision, selectedEffectiveBoundary).
```

A generated draft is not accepted background. User confirmation records exact draft/version/digest and simulation boundary. Partial background is valid authoring input; readiness identifies only missing fields that prevent simulation. Runtime defaults must not silently invent era, participants, economics, relationship axes or time scale. Fixtures and optional examples are explicitly examples.

Risu-inspired supported v1 semantics: primary/secondary exact token keys, always-active entries, priority, placement, bounded recursive activation, declarative comparisons, typed variable reads/assignments, recorded probability, event/fact/relationship/goal effect proposals. Retain source IDs and an import report. Risu import is a documented subset, not card/module compatibility. Unsupported regex/script/Lua/network/model/image/persona-write opcodes never execute; preserve them in a non-executable import report so authors can revise them. Broader compatibility requires a separately versioned parser and tests.

Lore order: apply actor/audience visibility → match keys against allowed perception → bounded recursion → evaluate expressions once with a step RNG receipt → budget whole records → place selected records. A discarded lore record cannot set accepted flags. Event prerequisite checks may read authoritative hidden state inside the resolver, but it must not alter the actor's visible candidate metadata before observation. Public narration never uses omniscient lore.

World updates produce a preview of affected locations, rules, actors and pending steps. Reject dangling references and impossible removals; require explicit relocation/effect mapping before activation. Cancel or invalidate stale proposals at the boundary. Existing events/images continue to use their historical definition version. Changing the background never rewrites prior events or persona identity. New agents enter by explicit membership event; retired agents cannot act, while historical relationships remain addressable.

`LifeConfig` separates simulation clock policy, manual/automatic run policy, actor/director model selection, invocation limits, usage policy, publication policy and image/avatar policy. Absent required automatic-run fields mean `not_configured`, not invented defaults. Manual preview can run with fixtures and no paid model. Authoring tools read without approval; mutations use the existing execution/approval mechanism and cannot gain privileges from imported text.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| User provides only era and environment | Retained text and draft choices; unresolved operational values shown; no running schedule/model call |
| Activate stale draft or edit a world while a proposal runs | Revision conflict; accepted world unchanged; stale proposal cannot commit |
| Import a supported lore entry beside a script/persona rewrite | Supported entry previews; unsupported entry is reported, with zero script/network/persona effects |
| Hidden key matches a public lore entry; recursive loop; budget drops a flag-setting entry | Hidden text cannot drive public selection; recursion ends; dropped entry has no flag effect |
| Render preview then accept with the same random record | Same evaluated text and result; preview does not consume accepted RNG state |
| Remove occupied place / retire participating agent / unknown opcode | Explicit validation failure or mapped migration; no dangling live state |
| Reload configured/unconfigured policies and unknown enum values | Configuration survives; unconfigured remains inactive; unknown values reject |

New files and tests are planned, not present commands. Actor/private-target noninterference is rechecked with 030. Use a bounded interpreter, not `eval`; process isolation in 030 is not a substitute for schema validation. Privileged direct API/DB writes remain outside the application boundary. Update `docs/PLANNING.md` and the Risu compatibility section in `docs/plans/platform/011_world_engine_risuai.md` only after demonstrated support.
