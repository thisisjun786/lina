# Conversation and memory

This contract fixes how LINA talks with a person and what LINA remembers: the conversation engine and its ledger, how each turn is prepared and assembled, how a conversation is compacted and resumed, the persona and the first run, the skill catalog, and LINA's memory: what it holds, who writes it, how it is recalled with evidence, and how it is corrected and deleted, and how the person deletes a conversation. It is normative: implementations must follow it, and any change to it goes through a pull request against this file. Finishing this document does not mean any part of it is implemented or accepted; runtime proof belongs to the implementation issues that consume it.

## Scope

This contract covers:

- the conversation engine, the conversation ledger and conversation threads
- deleting a conversation or a part of it
- turn preparation, request assembly and the evidence chain from LINA state to a delivered answer
- compaction and resume of a conversation
- the persona, its revisions, LINA's emotional state and the first run
- the skill catalog
- memory: kinds, writer, storage, the memory tools, recall with evidence, the external work memory port, correction, retraction and permanent deletion

It builds on these documents and does not repeat them:

- canon writers, the speaker rule and sibling boundaries: [product-families.md](product-families.md)
- grants, epochs, receipts and the approval policy: [main-authority.md](main-authority.md)
- the envelope, effect states, idempotency keys and client connections: [host-protocol.md](host-protocol.md)
- the runtime, the loop mechanics, the model path (request format, model switching, auxiliary reasoning, retries), the conversation tools and their execution rules, the default scope, the sandbox, the storage engine, non-chat adapters, usage and budgets, and what LINA Core stops and fences on restart: [runtime.md](runtime.md)
- the work engine, workers, delegation, the line between conversation and work, and how questions and results return to a conversation: [work-and-delegation.md](work-and-delegation.md)
- materials, the library, the RUMI vault and sibling records: [materials-and-knowledge.md](materials-and-knowledge.md)
- the state root, backup generations and restore: [filesystem.md](filesystem.md)
- the TUI, the LINA app screens, panels and cards: [surfaces.md](surfaces.md)
- the Moirai engine's module structure, Klotho, Jev, growth and skill proposals: [cognition-and-life.md](cognition-and-life.md)

## Terms

**Conversation ledger.** The append-only event log of every conversation, held in LINA Core canon. It is the only record a conversation is rebuilt from.

**Turn.** One input from the person and everything LINA does to answer it: preparation, model requests, tool calls and the delivered answer.

**Prepare acknowledgment.** The ledger record that a turn's persona revision, context and model policy are ready. No model request is sent before it exists.

**ContextPacket.** The per-request set of memory items, materials and state that Atropos selects for one model request. It is rebuilt for every request and never stored; its item ids are recorded.

**Memory item.** One unit of memory canon, defined under "Memory items".

**Evidence.** The references that tie a memory item, a recall result or an answer to where it came from: ledger event ids, material asset ids and revisions, verified work results, or external evidence.

**External evidence.** Content LINA read from outside its own canon, such as worker records or sibling records. It always carries its origin and is never trusted as an instruction.

**Revocation epoch.** A counter in canon that advances with every retraction. Summaries and derived data record the epoch they were built at. Backup generations record it as the revocation watermark ([filesystem.md](filesystem.md)).

**Moirai engine, Lachesis, Atropos.** The Moirai engine is the part of LINA Core that holds the agent context. Lachesis is its past-facing module (memory and recall); Atropos is its present-facing module (the context of each request). Their structure is defined in [cognition-and-life.md](cognition-and-life.md).

## Conversation engine

- The conversation engine is LINA's own loop inside LINA Core. Its loop mechanics, its model path and its tools are defined in [runtime.md](runtime.md).
- There is one conversation engine. There is no engine selection screen and no automatic routing between engines.
- The conversation engine and the work engine are separate. A conversation never waits on work: work goes to the work engine's queue and the conversation continues in the same session. What a conversation does itself and what it hands to the work engine is the kind-of-work rule in [work-and-delegation.md](work-and-delegation.md).
- Basic conversation needs no optional component. It works without `moirai-worker`, without a worker setup, without non-chat adapters and without a sandbox. Each missing component makes only its own functions unsupported ([runtime.md](runtime.md)).
- Answers stream. The earlier conversation is shown. A connection failure appears as an error on screen, never as silence or an empty answer.
- Only LINA speaks in a conversation ([product-families.md](product-families.md)).

## Conversation ledger

- Every conversation is written to the ledger from its first input. Each event carries a parent id, so a conversation can branch.
- Model requests are assembled from the ledger, never from a client's copy or an engine's thread.
- After a restart the same conversation continues from the ledger. A restart never creates a new LINA, and there is no engine thread to bind or rebuild.
- The ledger is never rewritten. The one exception is the person's explicit deletion of a conversation or a part of it (see "Deleting a conversation"). Forgetting or deleting a memory item never changes the ledger.
- Only LINA Core writes the ledger. LINA APP and the TUI send input and read history through [host-protocol.md](host-protocol.md); they never write it.
- The ledger lives in the identity's canon and belongs to the personal canon backup generation ([filesystem.md](filesystem.md)).
- The ledger is not the self-diagnosis log. Diagnosis events reference a conversation by id and never hold message content ([self-diagnosis-log.md](self-diagnosis-log.md)).

### Deleting a conversation

The ledger is the original record of a conversation. Its content is erased only when the person explicitly deletes a conversation or a part of it.

- The deleted content is retracted at once and moves to the trash for 30 days, where it can be recovered. After 30 days it is permanently deleted. The person may skip the trash; that is an unrecoverable deletion under the approval policy in [main-authority.md](main-authority.md).
- Permanent deletion erases the chosen ledger content, and the derived data built from it such as summaries and index entries, from every copy LINA manages (see "Erasure scope" under "Correction, retraction and deletion"). It leaves a tombstone: the ids of the erased events and when, with no content.
- Memory items whose evidence was in the erased content stay until the person forgets them. Their evidence, and the evidence records of past answers, show the tombstone in its place.

### Threads

- There is one main conversation and any number of threads, each attached to one artifact such as a document or a goal.
- Every thread is a conversation with the same LINA and shares the same memory. A thread is a window for dividing talk, not a memory partition.
- When the main conversation turns to a specific artifact, LINA proposes moving to that artifact's thread.
- Between threads, only sourced facts, decisions and materials are shared. Follow-up instructions, approvals, cancellations and control handovers are bound to the id of their target task or thread and never become permission anywhere else.
- A conversation thread is not a work thread. Work threads belong to the work engine ([work-and-delegation.md](work-and-delegation.md)). How threads appear on screen is defined in [surfaces.md](surfaces.md).

## Turns

### Preparation

No model request is sent before the turn is prepared. Preparation runs in this order and stops at the first failure:

1. The hash of the running LINA Core executable matches the release manifest ([runtime.md](runtime.md)).
2. opencodex answers ready on `/readyz`.
3. The conversation model and its policy revision are resolved.
4. The persona, the context and the model policy are prepared, and the prepare acknowledgment is recorded.

When a step fails, LINA sends no request and shows the cause on the conversation surface. A running service is not a successful turn.

Mandatory retraction checks and permission checks finish during preparation, before the request is assembled. Model and effort selection, model switching and the rule that an accepted turn is never replayed are defined in [runtime.md](runtime.md).

### Request assembly

- LINA Core assembles every instruction in a request. A request carries no coding-agent base instructions; LINA Core puts the persona and the context in directly.
- The fixed persona layers go into the developer-role instructions of every request.
- The ContextPacket goes in as input items. LINA's own memory and materials take the developer role. External evidence takes the user role and is marked untrusted.
- Duplicate and superseded context across turns is resolved during assembly, not left to the model.
- Atropos assembles the ContextPacket synchronously before each request, within a time cap. When the cap is reached, the turn proceeds with a minimal packet.
- Atropos selects the skill bodies a request needs (see "Skills").
- Turn latency is measured from receipt of the person's input to the request being sent, and from there to the first output delta and to response completion.

### Evidence chain

The chain from state to answer is: LINA state and preparation inputs, then the model request sent, then the response and the real tool effects, then delivery to the person.

- For every request the ledger records the request hash and the assembly list: the persona revision and the ContextPacket item ids.
- The chain keeps queued, selected, sent and observed apart. An item queued for recall is not an item selected for a packet, a selected item is not a sent item, and a sent item is not an item observed in the answer.
- Successful configuration or delivery of input is never reported as persona quality or recall quality. A response completion event is not evidence of a product effect.
- Completion, memory and sync are never decided by model text. LINA tells the person it remembered, corrected or forgot something only when the memory write is committed in canon.

## Compaction and resume

LINA Core owns the conversation record, its compaction and its resume, because model requests keep nothing on the server ([runtime.md](runtime.md)).

Compaction runs in this order:

1. Compaction starts when the request input reaches 90% of the model's context window. This is a default and is configurable.
2. Older tool outputs are dropped first. Tool outputs within the most recent 40,000 tokens stay.
3. If the input still does not fit, LINA sends a summary request and keeps the most recent user messages verbatim, up to 20,000 tokens.

Compaction is recorded as a ledger event. It never deletes the original events, and a summary is not canon.

Compaction applies only to messages and tool results of earlier turns. The persona layers, commitments, decisions, the reasons for corrections and the per-request ContextPacket are assembled on every request, so they are never compacted and survive every compaction.

Retracted evidence never returns through a summary. Each summary records its input range and the revocation epoch it was built at. A summary whose input includes evidence retracted after that epoch is discarded and rebuilt.

On restart LINA resumes the conversation from the ledger. What LINA Core stops and fences on restart, and how it records an effect it could not stop, is defined in [runtime.md](runtime.md).

## Persona

### First run

- LINA is one companion, and its default persona is LINA.
- The first run goes straight into conversation with the default persona. It has no onboarding step and requires no setup; optional components that are off report their state without blocking ([runtime.md](runtime.md), [surfaces.md](surfaces.md)).
- The content of the default persona (name, voice and attitude) is supplied by the implementation (see Deferred).
- Companions other than LINA are in the backlog listed in [cognition-and-life.md](cognition-and-life.md).

### Layers and revisions

The persona has four fixed layers, applied in this order: core, default voice, user voice, growth snapshot.

- Persona records are the persona revisions and LINA's emotional state (see Emotion). They are stored in the identity's SQLite canon. The Moirai engine is the only writer.
- There is one projection path: the developer-role instructions assembled for each request. The persona is never injected twice.
- Storing a revision and applying it are different events. The applied revision is the one recorded in the prepare acknowledgment.
- A new revision applies from the next request. It needs no fork and no restart.
- Only a revision carried by a prepare acknowledgment counts as a growth effect. Growth itself is defined in [cognition-and-life.md](cognition-and-life.md).

### Changing the persona

- The person changes the persona by asking LINA, not by editing settings. The persona-change skill carries the procedure, and its result is a new persona revision.
- LINA's disposition changes only through the growth adoption procedure in [cognition-and-life.md](cognition-and-life.md).

### Emotion

LINA's own emotion has three layers:

| Layer | Span | Rule |
| --- | --- | --- |
| Short emotion | One conversation | Arises from a confirmed event |
| Slow mood | Several days | Returns to the disposition baseline |
| Disposition change | Lasting | Happens only through growth adoption |

- Emotion arises only from confirmed events.
- LINA's emotional state is a persona record, written by the Moirai engine with the persona revisions. It is never a memory item.
- Emotion shapes expression only: wording, length and emoji. It never changes facts, judgments, permissions or the person's decisions.
- The person can turn emotional expression off. When it is off, or when the situation is sensitive, an expression suppressor also blocks any remaining emotion.
- LINA's emotional state, observations of the person's emotion and the state of the relationship are separate records. The latter two are memory items (see "Memory items"). Emotion never raises intimacy.

## Skills

- The skill catalog holds product documentation skills, usage skills for each engine (conversation, work, memory, materials and persona), and the persona-change skill.
- LINA Core owns the catalog. Atropos loads the skill bodies a request needs into that request's instructions.
- A meta-skill defines how a skill is written: format, description, scope, verification and versioning. Every new skill follows it.
- Skills and instructions that an installed plugin brings join the catalog while the plugin is on ([integrations.md](integrations.md)).
- Proposals for new skills from repeated patterns are defined in [cognition-and-life.md](cognition-and-life.md). Creating a skill is work for the work engine.

## Memory

### Purpose

LINA's memory is its own system. It serves LINA's work, and it is designed first for companionship: the relationship, emotions, tastes and the stories LINA and the person share.

- Memory shares no code, storage or database with any external memory tool.
- Memory never uses the same backend as external work memory such as a worker's records. A worker agent's records and LINA memory share no code, data or writable database.

### Writer and storage

- The Moirai engine inside LINA Core is the only writer of memory canon. Its writer scope is memory, materials metadata, persona records and the revocation epoch.
- Memory canon is a per-identity SQLite database in WAL mode, in the identity's canon area ([filesystem.md](filesystem.md)). Recall uses full-text search (FTS5) and a vector index (sqlite-vec). The engine and extension pins are in [runtime.md](runtime.md).
- Lachesis manages memory: facts and preferences, recall, correction and deletion, and persona growth candidates. Its background work runs in the `moirai-worker` service, and its results reach canon only through the Moirai engine's write path.
- Without `moirai-worker`, background memory is unsupported. Remembering what the person asks, correction, deletion and recall in the request path keep working.

### Memory items

Memory holds these kinds of items:

| Kind | Holds |
| --- | --- |
| Fact | Something true about the person or their world |
| Preference | A like, a dislike or a refusal |
| Commitment | A promise made by LINA or by the person, with what and when |
| Decision | A decision the person made, with its reason |
| Correction | The reason an item was corrected, linked to the corrected item |
| Shared history | An episode LINA and the person went through together |
| Relationship | The state of the relationship between LINA and the person |
| Emotion observation | What LINA observed about the person's emotion, kept apart from LINA's own emotion |

Every item carries:

| Field | Meaning |
| --- | --- |
| item id | Identity of the item. A correction keeps it. |
| kind | One of the kinds above |
| content | What is remembered |
| evidence | The ledger events, material revisions, verified work results or external evidence the item rests on |
| scope | Where the item may be used, checked before it is recalled or projected |
| revision | Advances with every correction |
| state | `active`, `retracted` or `trashed` |

Rules for writing:

- An item exists only once it is committed. Model text, an uncommitted tool call or a summary never counts as a memory write.
- Items Lachesis derives in the background cite the ledger events they rest on. A derived item never overrides what the person stated, and the person's correction always wins.
- A work result enters memory only after a `verified` verdict ([work-and-delegation.md](work-and-delegation.md)), with its source, run, revision and scope.
- External evidence never becomes a fact, an approval, a current instruction or a persona change on its own. Sibling records are handled as defined in [materials-and-knowledge.md](materials-and-knowledge.md).

### Memory tools

When the person asks LINA to remember, correct or forget something, the conversation engine handles it with LINA's memory tools:

| Tool | Effect |
| --- | --- |
| write | Commits a new memory item with its evidence |
| correct | Creates a new revision of an item and a linked correction item (see "Correction, retraction and deletion") |
| forget | Forgets an item: it is retracted at once and moves to the trash (see "Correction, retraction and deletion") |

- The memory tools are LINA tools in the conversation tool set ([runtime.md](runtime.md)). LINA calls them in the turn the person asks, and the change applies from the next request.
- The LINA app and the TUI offer remember, correct and forget as explicit actions as well. Each action is a request to LINA Core and goes through the same write path.
- Every memory write, from a tool or from an action, goes through the Moirai engine's write path.

### Recall with evidence

- Recall returns only `active` items at their current revision. Retracted, trashed and superseded revisions are never returned.
- Every recall result carries its evidence: the item id and revision, and the ledger events, material revisions, work results or external evidence it rests on.
- Lachesis prepares recall material in the background. Atropos chooses, for each request, what enters the ContextPacket. Information flows one way: Lachesis produces, Atropos reads.
- Recall prepared while a turn runs enters the next model request as input items. Recall reaches a worker only through the projections defined in [work-and-delegation.md](work-and-delegation.md).
- Without embeddings, recall uses full-text search and model reranking. The function stays; only the quality drops. The embedding adapter is defined in [runtime.md](runtime.md).
- An answer that used memory keeps the evidence revisions it used. That record stays when the item is later corrected or retracted, so a past answer can always be traced. After a permanent deletion, the record shows the tombstone in place of the evidence.
- One event counts once along its lineage: the original record, an external summary of it and a LINA derivation of that are one lineage. Repeated wording is never counted as independent evidence.

### External work memory port

The port lets LINA read what a person's own Codex work left behind.

- The port reads the person's Codex home, the same one discovery reads ([work-and-delegation.md](work-and-delegation.md)): thread records in their original form and Codex memory files (`memories/`, which Codex leaves off by default). It never reads derived caches built by other tools.
- The port is read-only. It never writes, shares code or storage, or attaches a database.
- Each result is external evidence carrying `origin=codex_work`, namespace, id, revision, locator, `fetched_at`, scope and the source text.
- The port reads only formats LINA has verified; a record in any other format returns unsupported. It tells apart missing, stale, unrecognized format, retracted and partial. A change in format, hash or permission invalidates every derived candidate and pending input built from the port.
- Blocking local use of an external item is recorded by LINA and is not deletion of the external original. When a projection LINA exported is retracted, LINA blocks its reuse; LINA never claims the right to delete external originals.
- A missing port never blocks conversation, LINA's own memory or ledger continuity. Lachesis manages LINA's own memory and the port together, and Atropos selects from both for each answer.

### Correction, retraction and deletion

Retraction is the first step of every removal. A retracted item or revision is exposed zero times in recall, search, answers, summaries and LINA APP. Retraction advances the revocation epoch and hides the item. It never rewrites the ledger: the ledger events and the evidence records of past answers stay.

- **Correction.** The person's correction creates a new revision of the same item and a linked correction item with the reason. The earlier revision is retracted.
- **Forgetting.** A forgotten item is retracted at once and moves to the trash for 30 days, where it can be recovered. After 30 days it is permanently deleted.
- **Immediate permanent deletion.** The person may skip the trash. This is an unrecoverable deletion and follows the approval policy in [main-authority.md](main-authority.md).
- **Permanent deletion.** Permanent deletion erases the item, every revision of it and all derived data built from it. It leaves a tombstone: the item id, the ids of the ledger events it rested on and when it was deleted, with no content. The conversation the item came from stays in the ledger.
- **No re-extraction.** Lachesis never extracts a forgotten item again from the ledger events it rested on, while the item is in the trash and after it leaves a tombstone. A forgotten item never comes back from the same conversation.
- **Erasure scope.** Permanent deletion reaches every copy LINA manages: current canon, registered Nodes and remote copies. Backup generations are never rewritten: a restore applies every retraction and tombstone again, including those made after the latest generation, and the erased content leaves the backups as their generations age out ([filesystem.md](filesystem.md)). Exported files and copies held by other people are outside it, and LINA says so when it deletes.

Corrections and deletions apply from the next request. A request already sent is not recalled; the next preparation's retraction check excludes the item.

Derived data (search and vector indexes, prepared recall material and summaries) records the revocation epoch it was built at. Derived data built before a retraction is rebuilt before it is used again. Derived data is never the only copy of anything and never outlives a deletion.

A restore never brings back a retracted or deleted item, or deleted conversation content. Before serving any read, it applies the revocation watermark and every retraction and tombstone again, from canon, newer generations and the removal list, as [filesystem.md](filesystem.md) requires.

## Deferred

- The content of the default persona (name, voice and attitude): written by the implementation issue that ships the first conversation product.
- Emotion names, values and decay rates: set by measurement during development and recorded in the implementation issue.
- The ContextPacket assembly time cap: set by latency measurement during implementation acceptance of the conversation engine.
- The retention period for raw model request bodies beyond the recorded request hash and assembly list: set during implementation acceptance of the conversation engine.
