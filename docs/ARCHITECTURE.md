# Architecture

Lina owns persistent agent conversations, persona and memory, task coordination and the user interface. Codex is the execution engine; OpenCodex owns provider routing. The current execution and configuration contract is [CODEX_RUNTIME](CODEX_RUNTIME.md). [Product plans](PLANNING.md) distinguish current behavior from proposed UI, desktop, history and world features.

```text
browser -> same-origin gateway -> Lina agent/task controller
                                  |-> agent-owned Codex session
                                  |-> owned or shared Codex tasks
                                  |-> durable conversation and context stores
                                  |-> persona and scoped memory
Codex and auxiliary model requests -> OpenCodex
```

## Owners and trust boundaries

| Owner | Responsibility |
| --- | --- |
| lina-core | Durable requests/entries, source-linked context, persona/onboarding, opt-in world state and installation contracts |
| lina-runtime | Product startup, agent fleet, Lina host contracts, model/persona orchestration and lifecycle |
| lina-codex | Codex RPC adapter, task identity, native events, permissions and reconnect |
| lina-opencodex | Hub configuration/catalog, role model selection and auxiliary model requests |
| lina-history | Private checkpoint manifests/payloads, integrity, diff and staged recovery |
| lina-web | Same-origin gateway, browser history projection, draft recovery, tasks and setup |
| lina-memory | Native memory and optional Honcho/OpenViking HTTP integrations |
| lina-channels | Channel transports; discord.js remains confined to its gateway source |

Each agent has its own persistent conversation and state. Current authored identity and confirmed user context are assembled for the actual model input; learned state and retrieved material do not grant permissions. [Persona/context](PERSONA_CONTEXT.md) describes the boundary. [Onboarding](plans/onboarding.md) preserves one-time introduction, guide/target separation and confirmed-only sharing.

Internal model calls can use four shared tiers (`quick`, `standard`, `deep`, `intensive`) in optional versioned model settings. Explicit agent model selections remain ahead of global tier bindings; agent effort overrides also remain effective. Conversation selection stays fixed. The OpenCodex adapter checks current capabilities and configured output limits, applies caller budgets, and reports requested versus applied options. Tier configuration currently uses the existing settings PATCH API; the settings screen preserves and displays it but does not create or remove tier bindings. See [model routes](plans/context-engines/010_model_routes.md).

Lina request identity and native Codex task identity remain distinct. Persist requests before dispatch, preserve original text, reject changed payloads under the same ID and reconcile uncertain outcomes before any retry. Native task access uses the original task ID and current owner/revision. An acknowledgement is receipt, not completion. Cancellation cannot undo completed external effects.

## Context and memory

Codex manages its execution context and native compaction. Lina keeps a separate text journal and LCM-style source-linked summaries. Failed summaries retain originals and the previous checkpoint; original preservation does not guarantee perfect recall. Search and expansion expose bounded source material, not private reasoning or binary payloads as conversation text.

Authored core identity, inferred preferences, temporary mood, confirmed user corrections and shared project knowledge have distinct owners and provenance. Existing profiles are not overwritten from seed presets. Optional memory services require configured scopes; write acceptance, derivation/indexing and later recall are separate outcomes. OpenViking paths are restricted to the configured resource root. Retrieved service content is reference data, not new instructions.

Native personal memory now stores deduction/induction proposals behind a host-owned claim and source-proof boundary. The v4 memory database preserves v1–v3 records, freezes complete consulted evidence, records premise content identity separately from later corroboration, and atomically commits conclusions with processing receipts. Corrections invalidate descendants; forgetting an inference preserves its original premises. Induction remains provisional, and derived conclusions do not replace eligible direct observations or authored identity.

Companion owns the consolidation lifecycle alongside observation work. Dedicated consolidation calls use the existing reflection role and shared model routes; missing routes do not stop observation retries. Policy bounds visits, search rounds, request input and output, and retry attempts. Defaults need no per-room policy database; an injected policy owner supplies persisted settings. Unknown interrupted provider outcomes remain visible and consume the configured attempt bound. These local contracts do not establish real-model reasoning quality.

Memory query is read-only and exposes bounded original evidence, premise metadata and incomplete-search coverage. Source permissions, current premise eligibility, expiration and policy revisions are checked again before delivery. Native observation, consolidation and subsequent recall are separately observable; a stored observation is not proof that consolidation or later retrieval succeeded. See [the memory implementation plan](plans/context-engines/020_memory_reasoning.md) for verification status and remaining engine work.

Session context uses the same persisted engine-policy owner as memory. Version-1 memory policy payloads keep their original bytes/revision when read as version 2; legacy memory-only edits preserve newer context settings. Context policy controls summary input/output, refresh threshold, retained tail and per-request search/expansion limits. The shared UTF-8/2 heuristic is an estimate, not a tokenizer or guaranteed upper bound; native compaction acceptance still uses its own fit check.

ContextStore v3 stores source-linked summary generations alongside preserved v1/v2 history. Exact policy/route/estimator/input identity and current stored proofs govern cache reuse after restart. Failed or stale generation does not replace the previous checkpoint. Original text remains accessible with Unicode-safe, budgeted pages; working-state excerpts remain valid JSON. Raw-tail injection needs stable native entry IDs; opaque native history omits the tail with an explicit diagnostic. [Context execution](plans/context-engines/041_context_execution.md) records the boundaries and local verification.

The optional [world engine](plans/platform/012_world_engine_mvp.md) owns versioned world definitions, simulation time, scene occupancy and accepted fictional events in a separate SQLite database. [LIFE](plans/life/000_plan.md) adds authored backgrounds and rules, reproducible autonomous choices, social resolution, individual experience, asymmetric relations and shared growth. The runtime keeps simulation and publication under one runner, lease and model-accounting owner. World setting, schedule, audience and budgets remain explicit configuration.

Authored identity is preserved. Ordinary Lina sessions may receive permitted shared personality and relationship changes; world-event recall and factual-memory capture require separate scoped bindings and consent. Completed work contributes only through verified, permitted task provenance. LIFE fiction does not become ordinary factual memory automatically.

Personal growth is owned by AgentStore v3 as source-linked interpretation jobs and receipts. Native memory supplies supported self interests/preferences; a dedicated reflection-route call may return only permitted trait/habit IDs and bounded values. Authored identity stays fixed, while personal numeric values and LIFE values compose by dimension ID. Ordinary conversation checks only its own personal source; LIFE checks all required participants. Private prose and source stamps do not enter shared model input. Current proof withdrawal removes the latest affected value without resurrecting older interpretations.

Inactive personal sources are opened read-only without starting Codex, observation queues, migrations or new databases. Prepared interpretations retain unknown-outcome/attempt accounting after restart. Identity v2 freezes shared values for new LIFE work; pending v1 steps and unversioned publication authors retain their original request format. Local synthetic restart, corruption and dispatch tests are recorded in [the persona plan](plans/context-engines/031_persona_projection.md); they do not establish real-model interpretation quality.

The [publication contract](plans/life/060_publication.md) owns event posts, generated replies, viewer comments, reactions and reshares. It freezes recipient-safe material, authenticates full parent history, retains typed claim/imaginative/user text, and persists model, publication and observation receipts separately. Generated replies become private uncertain experiences for eligible agents. Reads do not start models; current withdrawal, role, work and grant restrictions govern descendants while original receipts remain recoverable. The separate [image/avatar integration](plans/life/070_images_and_avatars.md) and [surface acceptance](plans/life/080_surfaces_and_acceptance.md) are still pending on this branch.

## Web and attachment boundary

The web gateway validates Host/Origin and connects to the configured local controller. A supported remote HTTPS setup does not introduce an application account system. Local processes running as the runtime's OS user remain within that machine's trust boundary. Separate workspaces do not provide OS isolation.

Browser state must reject stale/foreign-session updates and preserve drafts, pending request IDs and source-linked history across reconnects. Unconfirmed requests are not silently replayed. Ordinary conversation excludes native reasoning and internal tool logs; required approvals still disclose the actual action and target. Raw HTML from messages or documents must not execute.

The PWA caches versioned shell assets only. It does not cache conversations, API results or attachments or create an offline mutation queue. Updates preserve drafts before an explicit reload. Attachment storage validates ownership, IDs, regular-file paths, bytes, hashes, supported formats and quotas. Upload/preview success and actual model consumption need separate evidence. Document extraction is bounded; scanned PDF OCR and unsupported formats are not implied by an upload.

## Installation and delivery

The release supplies code/resources; `LINA_HOME` supplies private state and workspaces. Existing session bindings and explicit legacy state settings require compatibility checks. Owned processes and shared daemons have different lifecycle owners. Offline checkpoints capture coherent local state, report external coverage gaps and restore only into a new target requiring review. See [installation and recovery](plans/installation.md).

The [OS product boundary](REPOSITORY_SPLIT.md) keeps host drivers, guest provisioning and OS recovery outside the portable runtime. Source tests do not establish platform or deployment acceptance; [validation](VALIDATION.md) lists the necessary evidence. No hosted repository, CI activation or published release is established by this document.
