# LIFE engine: source research and implementation direction

Date: 2026-09-07. This records source inspection, isolated engine probes, and the revised product contract. The full LIFE feature described here is not implemented by the existing world-engine PR.

The subsequent [LIFE implementation roadmap](../life/000_plan.md) owns the complete dependency order, file-level changes and acceptance scenarios. The implementation sequence below is the research recommendation; use the roadmap for execution. It includes SNS interactions, event images and periodic avatars while leaving world/cadence/budget/publication settings open.

## Confirmed product contract

Understood as: the user authors a world's background, such as era and environment. Agents live inside that setting through contingent events, choices and consequences. Their experiences, secrets, personality development and relationships appear primarily in LIFE/SNS. Actual Lina work can change later opportunities and events.

The user explicitly confirmed that **personality and relationship development is shared with ordinary Lina conversation; raw events and secrets have a separate disclosure policy**. World state must therefore not be appended wholesale to an ordinary conversation. The authored persona is the starting identity; learned personality, values, habits and attitudes can develop without overwriting that source document.

The setting, time scale, operating cadence, generation budget, romance mechanics and publication audience remain user/world-author choices. Synthetic research examples select none of these for the product. Image rendering and UI remain separate workstreams, but the LIFE engine must provide their actual accepted-state inputs.

## Search and proof process

Two source-research waves covered three families:

1. RisuAI: world/character authoring, lore activation, variables, triggers, group behavior and storage.
2. Generative simulation: Concordia, AI Town, Sotopia, and newer agent-town prototypes.
3. Game social simulation: Ensemble/CiF and Neighborly, including action selection, consequences, social rules and personal history.

The second wave traced candidate failure paths and ran isolated probes for Ensemble and Concordia. It also checked a Neighborly precondition expression directly. Search snippets served only as leads; the implementation conclusions below use pinned source. Research stopped after these two waves supplied a concrete reusable core and identified the gaps Lina must own. It was not an exhaustive survey of every repository.

| Project | Inspected revision | Evidence level | Fit |
| --- | --- | --- | --- |
| RisuAI | `c454df882aaf32e02a22da26d3718c8cadc97814` | Pinned source; same HEAD as the earlier inspection | Authoring formats, contextual lore and declarative trigger semantics |
| Ensemble | `8b74bdec4ba2ef4e14795b7591df3b5d73f283e3` | Pinned source and a real standalone-engine probe under Bun | Reusable social-rule/action-selection core |
| Concordia | `9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c` | Pinned source, 15 upstream tests, real engine loop with fixture actors/GM | Generative actor/director orchestration and component design |
| Neighborly | `1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3` | Pinned source; isolated precondition-expression reproduction | Life-event scoring, career effects and personal history models |
| AI Town | `8e05997f2409275669c8344b84a51692e83f3f33` | Pinned source inspection | Durable input processing and engine generation guards |
| SimCore | `896875746c8ba251da4c7b8ea8f4efa3cddb5bc4` | Pinned source inspection | Not selected as the state-transition core |

## What deeper RisuAI inspection changes

The earlier work copied none of RisuAI's implementation and only built Lina's durable world ledger. RisuAI itself contains substantially richer authoring mechanisms, but those mechanisms have different responsibilities from a persistent social simulator.

### Lore selection is a pipeline, not an agent knowledge boundary

RisuAI combines character lore, current-chat lore and enabled module lore. It scans recent messages for primary and optional secondary keys, supports regex/always-active entries, and can use activated lore to activate more lore. Candidate activation happens before priority/token filtering; output placement is then ordered separately. This provides useful authoring behavior for local setting details and event prerequisites. [Loader and matching](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L75), [selection pipeline](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L488)

The loader reads the selected character/chat, and its signature has no acting-agent knowledge input. Keyword activation cannot enforce who knows a secret. Lina must filter knowledge before keyword matching, recursion, model input and public narration. A private entry must not activate or influence public lore merely because it shares a keyword. [Loader inputs](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L75), [lore schema](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/storage/database.svelte.ts#L1320)

Probability uses runtime randomness. Activation can set persistent flags before the selected entry survives the token budget. CBS expressions are evaluated for token counting and later output, so random expressions must not be evaluated independently in Lina's preview, budget calculation and final rendering. Use one evaluated result and a recorded random decision instead. These are source-derived integration risks; RisuAI runtime reproduction was not performed. [Activation/flags/budget](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/lorebook.svelte.ts#L565), [CBS randomness](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/cbs.ts#L2025)

### Trigger semantics are useful; their effects need a new execution boundary

The DSL covers input/start/output/manual/display/request phases, conditions, variables, arithmetic, collections, nested control flow and effects. Variable lookup combines local variables, chat state and authored defaults. Some effects also change character descriptions or persona prompts, call models/images, run scripts or stop sending. Lina should compile a supported declarative subset into event conditions/effects, with unsupported operations reported explicitly. [Trigger schema](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L20), [state lookup](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L1181), [persona effects](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L2119)

Stopping a prompt is not a rollback. The recursive trigger limit has a low-level override, and the loop's 100-iteration check yields briefly rather than ending execution. Lina needs an explicit action/recursion budget, cancellation boundary, staged effects and one atomic acceptance point. [Recursive dispatch](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L1400), [loop handling](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/triggers.ts#L1750)

### Group chat does not supply a relationship simulation

RisuAI's group path considers mentions, shuffling and speaking probability. It does not calculate a directional relationship graph in this path. Its persisted state is principally character/chat-oriented. These mechanisms can help select speakers for an encounter, but LIFE also needs goals, action consequences, personal knowledge and durable social development. [Group ordering](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/process/group.ts#L52), [chat state](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/storage/database.svelte.ts#L1817)

## Engine adoption assessment

### Recommended first integration: Ensemble social core behind Lina's acceptance boundary

Ensemble is an actual standalone JavaScript social engine. It has schema-defined boolean/numeric predicates, directed/reciprocal/undirected relations, trigger rules, volition rules, role binding, action selection, effects and historical state. The action pipeline can therefore turn an existing social situation into choices and consequences instead of merely asking a model for an SNS post. [Public API](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/ensemble.js#L984), [volition and triggers](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/RuleLibrary.js#L481), [action selection](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/ActionLibrary.js#L910)

The adoption target is the standalone core, not its old Electron/Grunt authoring application. Existing source uses a singleton and ambient randomness. Use a separate engine instance per world/proposal, JSON marshalling at the boundary, explicit random state, validated data-only rules and a bounded execution host. Its full social record must never be exposed as an agent's knowledge or as a public feed. The initial prototype proves mechanics, not production safety or every authored rule combination. [Source bundle manifest](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/build-library.js#L10), [random tie-breaking](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/ActionLibrary.js#L1115), [history load](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/socialRecord.js#L425)

This choice still requires a durable integration test before it becomes a production dependency: propose an action using only the actor's knowledge, stage resulting effects, atomically save the world/event/engine checkpoint, restart, and obtain the same next candidate order and random decisions. The prototype's restored relationship value alone does not prove this stronger contract.

`getActions()` is not the boundary of everything an NPC may attempt. Lina's model may form a new natural-language intention and translate it into validated combinations of supported effects or a world-pack extension proposal. Also, Ensemble's selected terminal actions can already reflect the target's acceptance/rejection. Those resolved branches must not be exposed as the initiating actor's advance knowledge. Separate actor-visible intentions from target response and authoritative resolution. [Action registration](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/ActionLibrary.js#L95), [selection and acceptance](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/ensemble/ActionLibrary.js#L974)

### Neighborly supplies useful event and work mechanics

Neighborly generates feasible life-event instances, evaluates considerations and chooses among eligible events with weighted randomness. Occupations apply recurring effects and affect later opportunities. This is a useful source for event eligibility, experience progression and causal career consequences. Its monthly time scale and particular thresholds are not Lina product decisions. The repository is archived and its license is MIT. [Event selection](https://github.com/ShiJbey/neighborly/blob/1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3/src/neighborly/systems.py#L798), [work effects](https://github.com/ShiJbey/neighborly/blob/1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3/src/neighborly/systems.py#L892), [repository](https://github.com/ShiJbey/neighborly), [license](https://github.com/ShiJbey/neighborly/blob/1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3/LICENSE)

Do not inherit its failure paths: the inspected job precondition uses `all([req(gameobject)] for req in requirements)`, whose nonempty lists are truthy even when a requirement returns false. The exact expression was reproduced independently. Its life-event history is appended before effects execute, which creates an inconsistency risk on failure. Port reviewed mechanisms with Lina tests and provenance rather than deploying the entire archived simulator unchanged. [Precondition](https://github.com/ShiJbey/neighborly/blob/1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3/src/neighborly/components/business.py#L308), [dispatch order](https://github.com/ShiJbey/neighborly/blob/1303cee0b8c404b1e3cf439e5c1a4b74d5e4ffe3/src/neighborly/life_event.py#L320)

### Concordia is a strong actor/director architecture reference and alternative runtime

Concordia separates entities, reusable components and simulation engines. The sequential engine requests observations, chooses an actor, requests its action, resolves the outcome with a game master, and exposes checkpoint/step callbacks. There are also simultaneous/asynchronous variants. This is a good model for LIFE's autonomous observe → intend → resolve → remember loop. A Python runtime with its provider/memory adapters is an alternative if the standalone social core proves too restrictive, not an additional mandatory engine in the first integration. [Sequential loop](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/concordia/environment/engines/sequential.py#L223), [package requirements](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/setup.py#L28)

The inspected observation component can use a targeted queue and can disable LLM fallback. Its default fallback generates an observation from model context, so a privacy projection remains necessary. Component snapshots exist, but restoration catches/logs some component exceptions. Narrative-push paths also use global randomness. Lina's accepted event log, complete checkpoint verification and model-result receipts are still required. [Observation queue/fallback](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/concordia/components/game_master/make_observation.py#L183), [restore](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/concordia/agents/entity_agent.py#L215), [narrative randomness](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/concordia/components/game_master/event_resolution.py#L1146)

### Other candidates

- AI Town has ordered inputs, engine-generation checks and same-mutation game/engine saving. Its memory pipeline is useful to study, but it couples the application to Convex and its scheduler/vector store. Its inspected memory records/search are keyed by player ID without a world ID while IDs restart within worlds; cross-world isolation therefore needs a separate proof. This is a source-derived concern, not a reproduced deployed failure. [Engine](https://github.com/a16z-infra/ai-town/blob/8e05997f2409275669c8344b84a51692e83f3f33/convex/engine/abstractGame.ts#L22), [memory schema](https://github.com/a16z-infra/ai-town/blob/8e05997f2409275669c8344b84a51692e83f3f33/convex/agent/schema.ts#L6), [memory search](https://github.com/a16z-infra/ai-town/blob/8e05997f2409275669c8344b84a51692e83f3f33/convex/agent/memory.ts#L158)
- Sotopia supplies private goals, secrets and social-scenario evaluation concepts. It is useful for an independent scenario test set rather than being assumed to provide durable multi-day LIFE operation. Only project documentation was inspected in this pass. [Project documentation](https://sotopia.world/projects/sotopia)
- SimCore is not selected as the authoritative action core. In the inspected code, trade does not transfer resources, work only reduces energy, and generic action application can update location after movement resolution failed. These are concrete missing mechanisms for the requested causal work/event system. [Interactions](https://github.com/elisonfrank/simcore/blob/896875746c8ba251da4c7b8ea8f4efa3cddb5bc4/simcore/world/interactions.py#L72), [action application](https://github.com/elisonfrank/simcore/blob/896875746c8ba251da4c7b8ea8f4efa3cddb5bc4/simcore/agents/agent.py#L135), [execution order](https://github.com/elisonfrank/simcore/blob/896875746c8ba251da4c7b8ea8f4efa3cddb5bc4/simcore/engine/simulation.py#L211)

## Revised runtime contract

One Lina-owned accepted state remains authoritative. Third-party simulation results are proposals until accepted. The implementation should add the following connected capabilities rather than isolated random-post generators.

| Owner | Required data and behavior |
| --- | --- |
| World authoring | Versioned era/environment/institutions/constraints, places, event families and supported rule schema. Natural-language background is retained beside its validated simulation representation. |
| Event director | Selects candidate situations from world conditions, outstanding goals, prior events, real-work inputs and recorded randomness. Supports a quiet step and bounded chains. |
| NPC decision | Uses authored identity, learned traits, needs/goals, its own experiences and its own knowledge to choose an intention among feasible actions. Model-generated alternatives are allowed; their proposed effects need validation. |
| Social resolution | Applies actor/target responses, directional relation changes, trait/habit development and knowledge disclosure as staged consequences. A→B and B→A are independent. |
| Experiences and beliefs | Records who experienced, observed, was told, inferred or falsely believed something, with source/cause references. World truth and an agent's belief are distinct. |
| Secrets | Records owners/knowers and explicit reveal/rumor transitions. Actor knowledge, permission to share, and viewer/feed visibility are separate. |
| Shared personality | Provides the same learned trait/relationship state to LIFE and ordinary Lina conversation, while preserving authored source identity and omitting event/secret bodies. A relationship change is not copied into two independently editable stores. |
| Work bridge | Receives deduplicated task-owner records with actual task/revision/source references and permitted shareable fields. Task completion is not automatically proof of task quality. Fictional consequences retain the real-work cause without becoming real-world observations. |
| LIFE projection | Produces audience-filtered accepted-event views and narration inputs for posts, replies and image briefs. A public post is not generated from a private agent's unrestricted memory. |
| Persistence/jobs | Atomically accepts event, social/knowledge deltas and engine checkpoint; retains candidate/rule/random/model-result provenance and durable side-effect intents. Recovery never rerolls an accepted outcome or republishes completed work. |

The engine must support personality formation with a traceable cause, not only temporary mood changes. The exact trait axes and change scales are authored/modeling decisions; no psychological validity is claimed for game scores. Stable persona anchors and adaptable learned state must be separately inspectable.

The canonical owner of LIFE-derived growth is the accepted LIFE social state, committed beside its world event and checkpoint. Both the NPC decision input and the ordinary persona compiler consume that same read-only projection; they must not each maintain an editable copy of the relationship graph. The existing authored `AgentStore` and factual conversational-memory stores retain their own source data. A configured world binding selects the LIFE source for an agent; multiple alternative worlds are not silently merged into one personality.

Growth must affect current choices and expression, not merely be stored as decorative metadata. The authored persona supplies the starting character and identity anchors; validated adaptive traits represent its current development. Explicit user edits and configured evolution locks remain authoritative. Normal-conversation export uses allowed trait/attitude fields and omits private cause text; a free-form model-written growth summary is not automatically safe to share.

### Ordinary conversation versus LIFE

The current `AppOptions.world` hook injects scene/event/fact data. That is a mismatch with the clarified product contract and must change before this connection is used in normal Lina conversations. Its core storage and scoped-read guarantees remain useful.

- Ordinary conversation receives a `SharedPersonaView`: current learned dispositions, habits and the speaking agent's permitted relationship attitudes. It does not automatically receive scene text, event logs, personal secrets or feed bodies.
- LIFE actors receive a `LifePerception`: their accessible world context, private goals/experiences, perceived relationships and feasible choices.
- Feed/image consumers receive a `PublicationView` for the intended audience. This can differ from what an actor knows or what the user is allowed to inspect as the world author.
- An explicit disclosure/recall path can expose selected events where permitted; merely connecting a world does not grant every tool or normal conversation access to its secrets.

### Example acceptance story

Use a synthetic world for tests, not a chosen product setting. Lina and another agent complete a real test task together. The task owner emits one validated work record. That record changes eligibility/weight for a later LIFE encounter. The agents respond differently according to their existing dispositions; one records a private concern, while trust increases in only one direction. The accepted event, personal experiences, knowledge and trait/relation changes survive restart.

A subsequent ordinary Lina request receives the updated disposition/relationship projection but not the concern, scene description or event body. A LIFE feed view shows only the permitted public encounter. Replaying the same work input or simulation step produces no duplicate growth, secret reveal, post or model reroll. The score/rule decisions and their source events remain inspectable.

## Implementation sequence and proof gates

1. **Replace the ordinary-chat coupling and define the shared growth owner.** Add explicit conversation/LIFE projections and negative tests proving that a secret/event body cannot enter a normal model request. Prove that a permitted trait/relation change does enter that request. Preserve the current persona, approval and Codex task regressions.
2. **Integrate the pinned social engine in an isolated headless adapter.** Validate supported data-only schema/rules/actions, preserve notices, control randomness, stage effects and enforce execution limits. Round-trip the complete checkpoint and compare future choices, not just one displayed score. Prove that a previously unlisted intention can be resolved from supported effect primitives, and that private target state cannot leak through the initiator's choices.
3. **Add authored backgrounds and autonomous event generation.** Reuse Risu's applicable authoring/lore semantics and Neighborly's reviewed eligibility/weighted-event mechanisms. Let actor intentions and world constraints affect outcomes. Prove quiet steps, changing candidate weights, rejected impossible actions and bounded event chains.
4. **Connect actual work, experience, secrets and personality development.** Use real source references and idempotent consumption. Test asymmetric relations, false beliefs, intentional disclosure, growth provenance, and no accidental promotion of fictional events into factual user memory.
5. **Drive LIFE/SNS and image consumers from accepted events.** UI and rendering remain their owners; the engine supplies real projections, durable publication intents and recovery semantics. Qualify actual model narration separately with the exact configured provider/model and an explicitly chosen run budget.

This sequence preserves the full product direction. It does not set a release date, world default, timer or spend limit. The runtime/model routing remains Lina-owned; the adoption must not create a parallel provider configuration or replace Codex's ownership of actual assistant/work sessions.

## Executed evidence and limits

- **Ensemble:** loaded the actual eight-module standalone source in separate Bun VM contexts. An upstream example's selected action changed directed closeness `10 → 20`; JSON history restored `20`; an independent engine retained `0`. With an explicit test PRNG, the run recorded two draws and final state `870155634`. No provider calls. The first wrapper attempt exposed `util.clone`'s cross-realm `instanceof` constraint; JSON parsing in each receiving realm resolved it. This is a wrapper/isolated-state probe, not a claim that VM is a security sandbox or that the example produces good personality development.
- **Concordia:** 15 upstream sequential-engine/response-parser tests passed with `pytest -n 0` in a temporary dependency target. A separate real `Sequential` loop with fixture actors/GM executed two resolutions, selected Alice then Bob, and emitted checkpoints `[1, 2]`. The fixture GM handled 13 engine-level calls; this is not an LLM-call count or cost estimate. All provider calls were zero. The fixture supplied scoped observations; this does not prove Concordia enforces secrecy itself.
- **Neighborly:** the exact job-requirement expression returned true for a false requirement. The complete simulator was not installed or run.
- **RisuAI/AI Town/SimCore:** source inspection only. Runtime effects and the identified source-derived risks require their own reproductions before claiming upstream defects beyond those demonstrated here.

No production dependency was added and no installed Lina state, provider account, UI, SNS account or service was used for these probes. Human-like personality quality and long-session narrative coherence remain unverified.

The repository includes a repeatable [standalone mechanics probe](../../../scripts/qa/life-social-engine-probe.ts). It requires an explicit clean upstream checkout, verifies the pinned commit plus all 15 source/fixture input files, and rejects wrong or modified sources before evaluation:

```sh
# Use a new research checkout, not a workspace containing someone else's work.
git clone https://github.com/ensemble-engine/ensemble.git <fresh-checkout>
git -C <fresh-checkout> checkout 8b74bdec4ba2ef4e14795b7591df3b5d73f283e3
bun scripts/qa/life-social-engine-probe.ts --source <fresh-checkout>
```

The successful probe reports forward relationship `10 → 20`, unchanged reverse relationship, JSON restore `20`, separate fresh world `0`, and the same selected action/random state for the same input and seed. Normal/negative source-input checks, direct TypeScript checking and Biome passed. Independent architecture review accepted the research direction and required the intention-versus-resolved-action and private-target-state tests specified above before product integration.

## Source and license handling

The inspected RisuAI root license is GPL-3.0; its RPack subdirectory has additional conditional licensing text. Ensemble uses the University of California BSD-4-Clause license with an advertising acknowledgement. Neighborly and AI Town have MIT licenses; Concordia has Apache-2.0. These are facts from the repositories, not a compatibility conclusion for a future combined distribution. Any actual copied/ported files require pinned provenance and preserved notices in Lina's third-party record. The current research imports none of that implementation into Lina's source tree. [RisuAI license](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/LICENSE), [RPack terms](https://github.com/kwaroran/RisuAI/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/rpack/LICENSE), [Ensemble license](https://github.com/ensemble-engine/ensemble/blob/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3/LICENSE.md), [Concordia license](https://github.com/google-deepmind/concordia/blob/9e4173f64a9f6c7990d2f5f52a11bc8e1f3aa61c/LICENSE)
