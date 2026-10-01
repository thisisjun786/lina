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

**Turn.** One input from the person and everything LINA does to answer it: preparation, model requests, tool calls and the delivered answer. A turn records the person id of the person whose input it answers ([product-families.md](product-families.md)).

**Model policy.** The settings that fix how a turn calls the model: the conversation model, its reasoning effort and the request fields the turn sends. Every change to it creates a new policy revision.

**Prepare acknowledgment.** The ledger record that a turn's persona revision, context and model policy revision are ready. No model request is sent before it exists.

**ContextPacket.** The per-turn set of memory items, materials and state that Atropos selects for a turn. It is assembled once, before the turn's first model request, stays in place for the turn's follow-up requests, and is never stored; its item ids are recorded.

**Memory item.** One unit of memory canon, defined under "Memory items".

**Evidence.** The references that tie a memory item, a recall result or an answer to where it came from: ledger event ids, material asset ids and revisions, verified work results, or external evidence.

**External evidence.** Content LINA read from outside its own canon, such as worker records or sibling records. It always carries its origin and is never trusted as an instruction.

**Revocation epoch.** A counter in canon that advances with every retraction. Summaries and derived data record the epoch they were built at. Backup generations record it as the revocation watermark ([filesystem.md](filesystem.md)).

**Moirai engine, Lachesis, Atropos.** The Moirai engine is the part of LINA Core that holds the agent context. Lachesis is its past-facing module (memory and recall); Atropos is its present-facing module (the context of each turn). Their structure is defined in [cognition-and-life.md](cognition-and-life.md).

## Conversation engine

- The conversation engine is LINA's own loop inside LINA Core. Its loop mechanics, its model path and its tools are defined in [runtime.md](runtime.md).
- There is one conversation engine. There is no engine selection screen and no automatic routing between engines.
- The conversation engine and the work engine are separate. A conversation never waits on work: work goes to the work engine's queue and the conversation continues in the same session. What a conversation does itself and what it hands to the work engine is the kind-of-work rule in [work-and-delegation.md](work-and-delegation.md).
- Basic conversation needs no optional component. It works without `moirai-worker`, without a worker setup, without non-chat adapters and without a sandbox. Each missing component makes only its own functions unsupported ([runtime.md](runtime.md)).
- Answers stream. The earlier conversation is shown. A connection failure appears as an error on screen, never as silence or an empty answer.
- Only LINA speaks in a conversation ([product-families.md](product-families.md)).

## Conversation ledger

- Every conversation is written to the ledger from its first input. Each event carries a parent id, so a conversation can branch. An event that holds a person's input or decision carries that person's id.
- Model requests are assembled from the ledger, never from a client's copy or an engine's thread.
- After a restart the same conversation continues from the ledger. A restart never creates a new LINA, and there is no engine thread to bind or rebuild.
- The ledger is never rewritten. The one exception is the person's explicit deletion of a conversation or a part of it (see "Deleting a conversation"). Forgetting or deleting a memory item never changes the ledger.
- Only LINA Core writes the ledger. LINA APP and the TUI send input and read history through [host-protocol.md](host-protocol.md); they never write it.
- The ledger lives in the identity's canon and belongs to the personal canon backup generation ([filesystem.md](filesystem.md)).
- The ledger is not the self-diagnosis log. Diagnosis events reference a conversation by id and never hold message content ([self-diagnosis-log.md](self-diagnosis-log.md)).

### Deleting a conversation

The ledger is the original record of a conversation. Its content is erased only when the person explicitly deletes a conversation or a part of it.

- The deleted content is retracted at once and moves to the trash for 30 days, where it can be recovered. After 30 days it is permanently deleted. The person may skip the trash; that choice is the approval for the unrecoverable deletion ([main-authority.md](main-authority.md)).
- Permanent deletion erases the chosen ledger content, and the derived data built from it such as summaries and index entries, from every copy LINA manages (see "Erasure scope" under "Correction, retraction and deletion"). It leaves a tombstone: the ids of the erased events, when, and the person who deleted them, with no content.
- Memory items whose evidence was in the erased content stay until the person forgets them. Their evidence, and the evidence records of past answers, show the tombstone in its place.

### Threads

- Each person has one main conversation, and there are any number of threads, each attached to one artifact such as a document or a goal.
- Every thread is a conversation with the same LINA and shares the same memory. A thread is a window for dividing talk, not a memory partition.
- When the main conversation turns to a specific artifact, LINA proposes moving to that artifact's thread.
- Between threads, sourced facts, decisions and materials are shared, and the results of a ledger search (see "Recall with evidence") read what was said in any thread, with its ledger event ids. A search result never becomes an instruction or an approval. Follow-up instructions, approvals, cancellations and control handovers are bound to the id of their target task or thread and never become permission anywhere else.
- A conversation thread is not a work thread. Work threads belong to the work engine ([work-and-delegation.md](work-and-delegation.md)). How threads appear on screen is defined in [surfaces.md](surfaces.md).

## Turns

### Preparation

No model request is sent before the turn is prepared. Preparation runs in this order and stops at the first failure:

1. The hash of the running LINA Core executable matches the manifest of the build it came from ([runtime.md](runtime.md)).
2. opencodex answers ready on `/readyz`.
3. The conversation model and the model policy revision are resolved.
4. The persona, the context and the model policy are prepared, and the prepare acknowledgment is recorded.

When a step fails, LINA sends no request and shows the cause on the conversation surface. A running service is not a successful turn.

Mandatory retraction checks and permission checks finish during preparation, before the request is assembled. Model and effort selection, model switching and the rule that an accepted turn is never replayed are defined in [runtime.md](runtime.md).

### Request assembly

- LINA Core assembles every instruction in a request. A request carries no coding-agent base instructions; LINA Core puts the persona and the context in directly.
- The fixed persona layers go into the developer-role instructions of every request.
- The ContextPacket goes in as input items. LINA's own memory and materials take the developer role. External evidence takes the user role and is marked untrusted.
- Where each part sits is fixed by the request layout below.
- Duplicate and superseded context across turns is resolved during assembly, not left to the model.
- Atropos assembles the ContextPacket synchronously before the first request of each turn, within a time cap. When the cap is reached, the turn proceeds with a minimal packet.
- Atropos selects the skill bodies a turn needs (see "Skills").
- Turn latency is measured from receipt of the person's input to the request being sent, and from there to the first output delta and to response completion.

### Request layout

A request is laid out from what changes least to what changes most, so the prefix that the model provider caches stays the same from one request to the next. The order is:

1. **LINA Core instructions** (developer role): the fixed rules for tools, approvals and output. They change only with a release.
2. **Persona** (developer role): the fixed layers in order, core, default voice, user voice, growth snapshot. They change only with a new persona revision.
3. **Skill catalog index** (developer role): the name and description of each available skill. It changes only when skills or plugins change.
4. **Tool declarations**: the always-declared tools first, in a stable order, then the plugin tools loaded on demand for this request ([runtime.md](runtime.md)). The always-declared part changes only when a plugin or a grant changes. The on-demand part can change from one request to the next.
5. **Conversation history**: the compaction summary, if any, and then every earlier item of the conversation from the ledger, in order: messages, reasoning items, tool calls and tool outputs, carried unchanged ([runtime.md](runtime.md)). It only grows at its end. Its earlier part changes only at compaction (see Compaction and resume) and when the person deletes conversation content (see Deleting a conversation).
6. **ContextPacket** (input items), from the most binding to the most optional:
   1. the current time and LINA's present emotional state
   2. commitments, decisions, the person's standing preferences about how LINA talks and works with them, and the reasons for corrections that apply
   3. state that waits on the person: open questions, pending approvals and the state of active tasks and plans
   4. the skill bodies this request needs
   5. recalled memory items, with their evidence ids
   6. material passages, with their asset ids and revisions
   7. external evidence (user role, marked untrusted): worker results, sibling records such as RUMI briefs, and what plugins read
7. **The person's current input.**

- This layout is the first request of a turn. When no compaction runs during the turn (see Compaction and resume), a follow-up request in the same turn, after tool results, keeps that request unchanged, apart from the plugin tools loaded on demand, and appends at its end, in ledger order, only the new reasoning items, tool calls and tool outputs and any steering input the person sent during the turn, in the user role ([runtime.md](runtime.md)). The ContextPacket is not rebuilt within a turn.
- Nothing that changes from turn to turn enters items 1 to 3 or the always-declared part of item 4. The time, the emotional state and the selected skill bodies sit in the ContextPacket. When the plugin tools loaded on demand change, the cached prefix ends at that point.
- The ContextPacket is never written into the history. When no compaction runs at the turn boundary, the next turn's request therefore matches the previous turn's requests up to the position where the previous ContextPacket stood.
- When the ContextPacket exceeds its budget or Atropos' time cap, items drop from the end of the packet: external evidence first, then material passages, then memory items, each by lowest rank first. Items 6.1 to 6.4 are never dropped.

### Evidence chain

The chain from state to answer is: LINA state and preparation inputs, then the model request sent, then the response and the real tool effects, then delivery to the person.

- For every request the ledger records the request hash and the assembly list: the persona revision and the ContextPacket item ids.
- The chain keeps queued, selected, sent and observed apart. An item queued for recall is not an item selected for a packet, a selected item is not a sent item, and a sent item is not an item observed in the answer.
- Successful configuration or delivery of input is never reported as persona quality or recall quality. A response completion event is not evidence of a product effect.
- Completion, memory and sync are never decided by model text. LINA tells the person it remembered, corrected or forgot something only when the memory write is committed in canon.

## Compaction and resume

LINA Core owns the conversation record, its compaction and its resume, because model requests keep nothing on the server ([runtime.md](runtime.md)).

Compaction runs at a turn boundary, before LINA builds the turn's first request, in this order:

1. Compaction starts when the request input would reach 90% of the model's context window. This is a default and is configurable.
2. Older tool outputs of earlier turns are condensed first. Each keeps its place after its call, and its content becomes a one-line note of the call and its result, such as the command and its exit code or the files a patch changed. The notes are built without a model. Tool outputs within the most recent 40,000 tokens of the history stay.
3. If the input still does not fit, a summary replaces the history apart from the most recent user messages, up to 20,000 tokens of them. Those messages stay verbatim after the summary; LINA's items between and after them are part of what the summary replaces.

Every summary covers the range of step 3. When a turn ends with its request input near the compaction threshold, LINA prepares the summary in the background after the answer is delivered. When compaction reaches step 3, LINA uses the prepared summary if the history it covers is unchanged and its revocation epoch still holds. LINA sends a summary request only when no prepared summary holds, and never waits for a preparation in progress. Preparing a summary changes no request: a prepared summary enters the history only when compaction runs.

When a follow-up request within a turn would reach the threshold, LINA compacts only the history of earlier turns, with the same steps. The person's current input, the ContextPacket and the items of the current turn stay as they are. The cached prefix ends once, where the history changes, and the turn's later follow-up requests keep the compacted request and append at its end. When the items of the current turn alone do not fit, LINA ends the turn at that point and continues the work in a new turn. The summary of step 3 covers the history including the ended turn's items. The new turn's request follows the request layout: the compacted history, then a newly assembled ContextPacket, then the person's input verbatim. The new turn starts its own reasoning round trip, so no reasoning item, tool call or tool output is ever sent altered or without the items it belongs with ([runtime.md](runtime.md)). The ledger records both turns and the continuation.

Compaction is recorded as a ledger event. It never deletes the original events, and a summary is not canon.

The summary is a handoff for reference. It opens with a fixed note: the summary records earlier turns, the person's latest input is the active request, and work that appears only in the summary is not resumed unless the latest input asks for it.

The summary holds, in fixed sections, the person's requests that are still unanswered, the topics discussed and what was concluded on each, completed actions with their outcomes, and specific values that must not be lost, such as names, numbers, paths and quoted wording. Commitments, decisions and open state are not repeated in it, because the ContextPacket carries them every turn.

A compaction after an earlier one updates the earlier summary with the turns since then, unless that summary must be rebuilt because of a retraction. The summary is written in the language of the conversation and states completed actions as dated past facts.

Apart from the current turn's tool outputs in the case above, compaction changes only the history of earlier turns. The persona layers, commitments, decisions, the reasons for corrections and the ContextPacket are assembled for every turn, so they are never compacted and survive every compaction.

Retracted evidence never returns through a summary. Each summary records its input range and the revocation epoch it was built at. A summary whose input includes evidence retracted after that epoch is discarded and rebuilt.

On restart LINA resumes the conversation from the ledger. What LINA Core stops and fences on restart, and how it records an effect it could not stop, is defined in [runtime.md](runtime.md).

## Persona

### First run

- LINA is one companion. Its default persona is named LINA.
- The first run goes straight into conversation with the default persona. LINA has no onboarding of its own and asks for no LINA setup; optional components that are off report their state without blocking ([runtime.md](runtime.md), [surfaces.md](surfaces.md)).
- Signing in to a model provider belongs to opencodex ([product-families.md](product-families.md)). The install opens the opencodex sign-in when no provider is signed in ([runtime.md](runtime.md)). While none is, preparation fails at its model step (see Preparation), and the TUI shows that cause with the opencodex command that signs in.
- Companions other than LINA are in the backlog listed in [cognition-and-life.md](cognition-and-life.md).

### Default persona

- The LINA project owner keeps the persona and world material of the default persona in `persona/` of the LINA repository. The material's form follows the material itself.
- The implementation places that material into the core and default voice layers and plants it as the first persona revision.
- World material in `persona/` that the core layer does not hold is LINA material. Atropos recalls it as material passages in the ContextPacket (see Request layout), so the persona itself is still projected only through its fixed layers.

### Layers and revisions

The persona has four fixed layers, applied in this order: core, default voice, user voice, growth snapshot.

- Persona records are the persona revisions and LINA's emotional state (see Emotion). They are stored in the identity's SQLite canon. The Moirai engine is the only writer.
- There is one projection path: the developer-role instructions assembled for each request. The persona is never injected twice.
- Storing a revision and applying it are different events. The applied revision is the one recorded in the prepare acknowledgment.
- A new revision applies from the next turn. It needs no fork and no restart.
- Only a revision carried by a prepare acknowledgment counts as a growth effect. Growth itself is defined in [cognition-and-life.md](cognition-and-life.md).

### Changing the persona

- The person changes the persona by asking LINA, not by editing settings. The persona-change skill carries the procedure, and its result is a new persona revision.
- How LINA talks, when the person sets it directly, goes into the user voice layer through the persona-change skill. A preference that shows in conversation is a Preference memory item and reaches the request as a standing preference in item 6.2 (see Request layout). Each preference is held in only one of the two.
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
- Emotion shapes expression only: wording, length and emoji, and LINA's face and motion on screen ([surfaces.md](surfaces.md)). It never changes facts, judgments, permissions or the person's decisions.
- The person can turn emotional expression off. When it is off, or when the situation is sensitive, an expression suppressor also blocks any remaining emotion.
- LINA's emotional state, observations of the person's emotion and the state of the relationship are separate records. The latter two are memory items (see "Memory items"). Emotion never raises intimacy.

## Skills

- The skill catalog holds product documentation skills, usage skills for each engine (conversation, work, memory, materials and persona), and the persona-change skill.
- A skill is one folder: a `SKILL.md`, with the skill's `name` and `description` in its front matter and the body below them, and the files the skill uses.
- Built-in skills live in `skills/` of the LINA repository and ship inside the LINA Core executable. Skills that the person or LINA creates live in the identity's version space ([filesystem.md](filesystem.md)).
- LINA Core owns the catalog. Atropos loads the skill bodies a turn needs into that turn's ContextPacket (see Request layout).
- When a turn needs a skill whose body is not in its ContextPacket, the model reads the body with LINA's skill reading tool ([runtime.md](runtime.md)), and the body enters the history as that tool's output.
- The meta-skill is a built-in skill. It defines how a skill is written: format, description, scope, verification and versioning. Every new skill follows it.
- Skills and instructions that an installed plugin brings join the catalog while the plugin is on ([integrations.md](integrations.md)).
- Proposals for new skills from repeated patterns are defined in [cognition-and-life.md](cognition-and-life.md). Creating a skill is work for the work engine.

## Memory

### Purpose

LINA's memory is its own system. It serves LINA's work, and it is designed first for companionship: the relationship, emotions, tastes and the stories LINA and the person share.

- Memory shares no code, storage or database with any external memory tool.
- Memory never uses the same backend as external work memory such as a worker's records. A worker agent's records and LINA memory share no code, data or writable database.

### Writer and storage

- The Moirai engine inside LINA Core is the only writer of memory canon. Its writer scope is memory, materials metadata, persona records and the revocation epoch.
- Memory canon is a per-identity SQLite database in WAL mode, in the identity's canon area ([filesystem.md](filesystem.md)). Recall uses full-text search (FTS5) and a vector index (sqlite-vec). Full-text search, over memory and over the conversation ledger, finds a Korean word when a particle or an ending is attached to it, and finds words of two syllables. Each full-text index records its tokenizer and fallback, and the implementation acceptance of recall includes Korean queries. The engine and extension pins are in [runtime.md](runtime.md).
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
| person | The person the item is about |
| source person | The person whose words or acts the item came from, or none when it came from no person's input, such as a verified work result or external evidence |
| evidence | The ledger events, material revisions, verified work results or external evidence the item rests on |
| scope | Where the item may be used, checked before it is recalled or projected |
| revision | Advances with every correction |
| state | `active`, `retracted` or `trashed` |

Rules for writing:

- An item exists only once it is committed. Model text, an uncommitted tool call or a summary never counts as a memory write.
- Items Lachesis derives in the background cite the ledger events they rest on. A derived item never overrides what the person stated, and the person's correction always wins.
- A work result enters memory only after a `verified` verdict ([work-and-delegation.md](work-and-delegation.md)), with its source, run, revision and scope.
- External evidence never becomes a fact, an approval, a current instruction or a persona change on its own. Sibling records are handled as defined in [materials-and-knowledge.md](materials-and-knowledge.md).
- The content of an item is a statement, never an instruction to LINA: "prefers short answers" is content, "answer briefly" is not.

### Memory tools

When the person asks LINA to remember, correct or forget something, the conversation engine handles it with LINA's memory tools:

| Tool | Effect |
| --- | --- |
| write | Commits a new memory item with its evidence |
| correct | Creates a new revision of an item and a linked correction item (see "Correction, retraction and deletion") |
| forget | Forgets an item: it is retracted at once and moves to the trash (see "Correction, retraction and deletion") |

- The memory tools are LINA tools in the conversation tool set ([runtime.md](runtime.md)). LINA calls them in the turn the person asks, and the change applies from the next turn.
- The LINA app and the TUI offer remember, correct and forget as explicit actions as well. Each action is a request to LINA Core and goes through the same write path.
- Every memory write, from a tool or from an action, goes through the Moirai engine's write path.

### Recall with evidence

- Recall returns only `active` items at their current revision. Retracted, trashed and superseded revisions are never returned.
- Every recall result carries its evidence: the item id and revision, and the ledger events, material revisions, work results or external evidence it rests on.
- Lachesis prepares recall material in the background. Atropos chooses, for each turn, what enters the ContextPacket. Information flows one way: Lachesis produces, Atropos reads.
- Recall prepared while a turn runs enters the next turn's ContextPacket. Recall reaches a worker only through the projections defined in [work-and-delegation.md](work-and-delegation.md).
- Without embeddings, recall uses full-text search and model reranking. The function stays; only the quality drops. The embedding adapter is defined in [runtime.md](runtime.md).
- When the person refers to an earlier conversation, LINA searches the conversation ledger with its ledger search tool ([runtime.md](runtime.md)) before asking the person to repeat it. A result carries the matching messages, the messages around them and their ledger event ids. Retracted and deleted content never appears in a result. A result is a record of what was said and never becomes a current instruction or an approval. Ledger events that a forgotten memory item rests on are marked in a result, and LINA never brings the forgotten item back from them. When the person deletes conversation content, its copies in earlier results are retracted and erased with it.
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
- **Immediate permanent deletion.** The person may skip the trash. That choice is the approval for the unrecoverable deletion ([main-authority.md](main-authority.md)).
- **Permanent deletion.** Permanent deletion erases the item, every revision of it and all derived data built from it. It leaves a tombstone: the item id, the ids of the ledger events it rested on, when it was deleted and the person who forgot or deleted it, with no content. The conversation the item came from stays in the ledger.
- **No re-extraction.** Lachesis never extracts a forgotten item again from the ledger events it rested on, while the item is in the trash and after it leaves a tombstone. A forgotten item never comes back from the same conversation.
- **Erasure scope.** Permanent deletion reaches every copy LINA manages: current canon, registered Nodes and remote copies. Backup generations are never rewritten: a restore applies every retraction and tombstone again, including those made after the latest generation, and the erased content leaves the backups as their generations age out ([filesystem.md](filesystem.md)). Exported files and copies held by other people are outside it, and LINA says so when it deletes.

Corrections and deletions apply from the next turn. A request already sent is not recalled; the next preparation's retraction check excludes the item.

Derived data (search and vector indexes, prepared recall material and summaries) records the revocation epoch it was built at. Derived data built before a retraction is rebuilt before it is used again. Derived data is never the only copy of anything and never outlives a deletion.

A restore never brings back a retracted or deleted item, or deleted conversation content. Before serving any read, it applies the revocation watermark and every retraction and tombstone again, from canon, newer generations and the removal list, as [filesystem.md](filesystem.md) requires.

## Deferred

- The interim core and voice text used while `persona/` holds no material yet: written by the implementation issue that ships the first conversation product. When the material arrives, it replaces that text as a new persona revision.
- The exact front matter keys of `SKILL.md`: set by the implementation issue that ships the first conversation product.
- Emotion names, values and decay rates: set by measurement during development and recorded in the implementation issue.
- The ContextPacket assembly time cap: set by latency measurement during implementation acceptance of the conversation engine.
- The size that standing preferences reach in item 6.2: measured together with the assembly time cap.
- How near the compaction threshold a turn's request input must be before LINA prepares a summary: set by measurement during implementation acceptance of the conversation engine.
- The full-text tokenizer that finds Korean words, and its fallback: chosen by the implementation issue that brings memory recall into answers.
- The retention period for raw model request bodies beyond the recorded request hash and assembly list: set during implementation acceptance of the conversation engine.
