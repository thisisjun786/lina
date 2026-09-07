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
| lina-core | Durable requests/entries, source-linked context, persona/onboarding and installation contracts |
| lina-runtime | Product startup, agent fleet, Lina host contracts, model/persona orchestration and lifecycle |
| lina-codex | Codex RPC adapter, task identity, native events, permissions and reconnect |
| lina-opencodex | Hub configuration/catalog, role model selection and auxiliary model requests |
| lina-history | Private checkpoint manifests/payloads, integrity, diff and staged recovery |
| lina-web | Same-origin gateway, browser history projection, draft recovery, tasks and setup |
| lina-memory | Native memory and optional Honcho/OpenViking HTTP integrations |
| lina-channels | Channel transports; discord.js remains confined to its gateway source |

Each agent has its own persistent conversation and state. Current authored identity and confirmed user context are assembled for the actual model input; learned state and retrieved material do not grant permissions. [Persona/context](PERSONA_CONTEXT.md) describes the boundary. [Onboarding](plans/onboarding.md) preserves one-time introduction, guide/target separation and confirmed-only sharing.

Lina request identity and native Codex task identity remain distinct. Persist requests before dispatch, preserve original text, reject changed payloads under the same ID and reconcile uncertain outcomes before any retry. Native task access uses the original task ID and current owner/revision. An acknowledgement is receipt, not completion. Cancellation cannot undo completed external effects.

## Context and memory

Codex manages its execution context and native compaction. Lina keeps a separate text journal and LCM-style source-linked summaries. Failed summaries retain originals and the previous checkpoint; original preservation does not guarantee perfect recall. Search and expansion expose bounded source material, not private reasoning or binary payloads as conversation text.

Authored core identity, inferred preferences, temporary mood, confirmed user corrections and shared project knowledge have distinct owners and provenance. Existing profiles are not overwritten from seed presets. Optional memory services require configured scopes; write acceptance, derivation/indexing and later recall are separate outcomes. OpenViking paths are restricted to the configured resource root. Retrieved service content is reference data, not new instructions.

## Web and attachment boundary

The web gateway validates Host/Origin and connects to the configured local controller. A supported remote HTTPS setup does not introduce an application account system. Local processes running as the runtime's OS user remain within that machine's trust boundary. Separate workspaces do not provide OS isolation.

Browser state must reject stale/foreign-session updates and preserve drafts, pending request IDs and source-linked history across reconnects. Unconfirmed requests are not silently replayed. Ordinary conversation excludes native reasoning and internal tool logs; required approvals still disclose the actual action and target. Raw HTML from messages or documents must not execute.

The PWA caches versioned shell assets only. It does not cache conversations, API results or attachments or create an offline mutation queue. Updates preserve drafts before an explicit reload. Attachment storage validates ownership, IDs, regular-file paths, bytes, hashes, supported formats and quotas. Upload/preview success and actual model consumption need separate evidence. Document extraction is bounded; scanned PDF OCR and unsupported formats are not implied by an upload.

## Installation and delivery

The release supplies code/resources; `LINA_HOME` supplies private state and workspaces. Existing session bindings and explicit legacy state settings require compatibility checks. Owned processes and shared daemons have different lifecycle owners. Offline checkpoints capture coherent local state, report external coverage gaps and restore only into a new target requiring review. See [installation and recovery](plans/installation.md).

The [OS product boundary](REPOSITORY_SPLIT.md) keeps host drivers, guest provisioning and OS recovery outside the portable runtime. Source tests do not establish platform or deployment acceptance; [validation](VALIDATION.md) lists the necessary evidence. No hosted repository, CI activation or published release is established by this document.
