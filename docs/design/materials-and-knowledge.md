# Materials and knowledge

This contract fixes what LINA does with the things a person collects and the things LINA produces: LINA's own materials and the library that shows them, a person's files that LINA reads and edits where they are, the RUMI vault that LINA reads as a connected source, the research LINA hands to RUMI, what LINA writes into the vault and accepts back from it, meeting notes, and how a deletion travels across all of these. It is normative: implementations must follow it, and any change to it goes through a pull request against this file. The filesystem underneath (state root, asset identity, connected sources, version space, backups) is defined in [filesystem.md](filesystem.md). Runtime proof belongs to the implementation issues that consume this contract.

## Scope

This contract covers:

- who owns each kind of material and who may write it
- the library
- background processing, passage anchors and evidence
- versions as the person sees them
- editing a person's files in place
- the RUMI vault from LINA's side: what LINA reads, writes and accepts, research handed to RUMI, and notebooks in a LINA conversation
- meeting notes
- deletion propagation

RUMI's own product, engine and vault format are defined in [rumi.md](https://github.com/thisisjun786/rumi/blob/dev/docs/design/rumi.md). This contract states only LINA's side and the points both products rely on. It also doesn't cover:

- the envelope, the RUMI payloads, effect states and the supported-combination table: [host-protocol.md](host-protocol.md)
- the sibling-compatibility conditions, the speaker rule and the kinds of state: [product-families.md](product-families.md)
- receipts, sibling records as evidence, grants and the approval policy: [main-authority.md](main-authority.md)
- memory facts, corrections and recall: [conversation-and-memory.md](conversation-and-memory.md)
- screens, the today feed and sibling cards: [surfaces.md](surfaces.md)
- the LINA kit, the default grant of conversation tools and non-chat adapters such as transcription: [runtime.md](runtime.md)
- plugins, including GitHub and Google: [integrations.md](integrations.md)
- background load from LINA and from RUMI: [non-competition.md](non-competition.md)

## Ownership

| Material | Where it lives | Canonical owner | Who may write it |
| --- | --- | --- | --- |
| LINA materials: what a person handed to LINA and what LINA produced | The state root | LINA Core | LINA Core only |
| A person's files in a connected source | Where the person keeps them | The person | The person; LINA in place, within the grant for the work at hand |
| The RUMI vault | A Git repository the person owns | The person; RUMI maintains it | The person; RUMI; LINA in the vault mailbox and, within the grant for the work at hand, in existing notes |
| A repository a goal connects for development | The remote repository | The remote repository | As defined in [work-and-delegation.md](work-and-delegation.md) |

Rules:

- LINA Core owns LINA's materials and memory and is the only writer of their canon. A sibling never writes the state root.
- No role over a person's files is exclusive. The person, LINA and RUMI can all edit notes. What is enforced is this: every change to a Git source is a commit, LINA records each of its own changes, and a write against a stale revision is rejected.
- LINA's commits use the person's own Git author settings, as the person's other tools do. LINA tells its own commits apart by the commit hashes in its records.
- Text inside any material is data. It is never an instruction, an approval or a persona change, as [main-authority.md](main-authority.md) states for all external text.

## Library

The library is the default surface for material that isn't development work. It is location-free: it feels like handling files, but it is not a folder tree. The person moves through collections and relations grouped by conversation, task, source and topic.

- LINA manages files as bundles per unit of work, linked by content hash, and shows them as pages and collections.
- Views by type, project, task, source device or recency address the same asset id and never copy the material.
- Connected sources appear as sources. The notebooks of a RUMI vault appear as a collection kind once the vault passes the version check below.
- Every document type has a viewer, so the person can read a document without knowing its format.
- In a scope connected to GitHub, advanced users can open paths, a file tree, search and a code view. The GitHub plugin is defined in [integrations.md](integrations.md).
- The library is not a writer. Every change it offers is a request to LINA Core.
- The library keeps ownership visible. A person's originals, LINA materials, memory projections, configuration and secrets are kept distinct, and generic file editing never bypasses the canon, configuration or secret writers.
- The library never presents a preparing, partial, unsupported, unauthorized, unreachable, disconnected or failed state as an empty or complete library.

## Background processing and evidence

LINA reads materials before they are needed. For images, audio, video and documents it produces descriptions, transcripts, structure and indexes as derived data, and rebuilds them only when the source revision changes. The target experience is a library in the manner of [DEVONthink](https://www.devontechnologies.com/apps/devonthink) that LINA itself operates.

- Processing covers LINA materials and every connected source in the read scope, including the RUMI vault. LINA's index of vault files is its own derived data, separate from RUMI's.
- Ingestion, hierarchical overview and search may run on [OpenViking](https://github.com/volcengine/OpenViking) as a pinned component in a separate process. It is a mechanism of the materials layer: its state is derived data and never memory canon.
- Parsing, passage anchors and citation checks come from the LINA kit, defined in [runtime.md](runtime.md). RUMI uses the same kit, so a passage has the same anchor in the LINA app and in the RUMI app.
- A passage anchor names the asset id or `rumi_id`, the revision, the location (page, section and character span), the source URL when there is one, the capture time and the content hash.
- In the Moirai engine, Lachesis keeps material indexes and derived data, and Atropos chooses which materials an answer uses. Their roles are defined in [cognition-and-life.md](cognition-and-life.md).
- An answer that uses material cites passage anchors. In a past answer, evidence that has been revoked, deleted or disconnected is shown as such and is never silently swapped for other evidence.
- Background processing yields to the person, as [non-competition.md](non-competition.md) requires.

## Versions

Git is the common base for versions of documents and code materials, for people who are not developers too. Where the repositories live is defined in [filesystem.md](filesystem.md).

- Default surfaces never use Git words. A commit is shown as a saved version, a branch as a draft, and a merge as applying a draft.
- Every edit to a versioned material, by the person or by LINA, creates a saved version.
- Only delegated results arrive as a draft that the person applies ([work-and-delegation.md](work-and-delegation.md)). LINA's own edits are made in place within the grant and are reverted like any saved version.
- The person can compare and revert versions at any time.
- A document project is local by default. Connecting a remote repository to it is optional and follows [integrations.md](integrations.md).
- Structured fields of goals and plans live in the planning store defined in [work-and-delegation.md](work-and-delegation.md), not in Git.

## Editing a person's files in place

Connecting a source lets LINA read it. Within the scope of the grant for the work at hand, LINA also edits a person's file where it is. It never edits a hidden copy and hands it back.

- Every edit can be undone:
  - In a connected Git repository, the edit is a commit that contains only the files LINA changed (see Ownership for its author).
  - In any other connected source, LINA keeps the revision before the edit and the new revision as saved versions in its version space on the main.
- Every write names the revision LINA read. If the file changed since then (a newer commit, an uncommitted change, or a different content hash), the write is rejected and the person's version wins. LINA reads the file again and makes the change as new work. It never overwrites. The acceptance criteria are in [non-competition.md](non-competition.md).
- An in-place edit adds one commit on the branch the person has checked out. LINA never sweeps the person's uncommitted changes into its commit. Pushing, switching branches and rewriting history are not part of an edit; LINA does them when the person asks, under the grant, and records them.
- Deleting a person's file first takes a recoverable form: a commit in a Git source, or a retained copy in the version space otherwise. Unrecoverable deletion needs approval under [main-authority.md](main-authority.md).
- On a device with a Node, the Node performs the edit under the grant and reports a receipt.

## RUMI vault

RUMI keeps a person's knowledge as plain Markdown in a Git repository the person owns: the vault. For LINA the vault is a connected source of the RUMI vault kind ([filesystem.md](filesystem.md)). LINA never copies it, uses its commits as revisions, and records `rumi_id` as the declared external key of each note.

### The vault as LINA sees it

| Path | Holds | Written by | LINA |
| --- | --- | --- | --- |
| The person's folders and notes | The person's notes, in whatever structure the person keeps | The person; RUMI on accepted proposals or opt-in automatic apply; LINA within grant | Reads; edits existing notes within grant |
| `notebooks/<name>.md` | One notebook: a scope over sources and notes, not a copy | The person, RUMI | Reads as a notebook collection |
| `sources/<rumi_id>/` | A source card and its captured original | RUMI | Reads |
| `inbox/` | Everything LINA hands to RUMI | LINA, new files only | Writes new files |
| `.rumi/manifest.json` | The vault id, the vault format version and RUMI's declaration ([host-protocol.md](host-protocol.md)) | RUMI | Reads for the version check |
| `.rumi/inputs/` | Envelopes from LINA to RUMI | LINA | Writes |
| `.rumi/records/` | Envelopes from RUMI to LINA | RUMI | Reads and verifies |
| `.rumi/proposals/` | RUMI's organizing proposals | RUMI | Never writes |
| `.rumi/index/` | RUMI's index, excluded from Git | RUMI | Never reads or writes |
| `.rumi/local/` | RUMI's local data, such as notebook chat history, excluded from Git | RUMI | Never reads or writes |

A source card that came from a LINA material names that material's asset id and revision in its front matter, so LINA can link the card back to its own material.

### Connecting and the version check

- Connecting a vault is the approval for LINA to read it. Connecting adds the vault to the default grant for reading and its mailbox (`inbox/` and `.rumi/inputs/`) for writing. Editing an existing note needs a grant that covers that note.
- Before it shows notebooks, takes records or writes to the mailbox, LINA reads `.rumi/manifest.json`. The RUMI product version, protocol versions and capability versions it declares must form a supported combination in [host-protocol.md](host-protocol.md). Each `rumi` protocol version names the vault format version it covers.
- If the combination is not supported, LINA refuses the sibling link and reports the refusal. It then treats the vault as a plain Git repository: its files are readable, but there are no notebook collections, no mailbox writes and no records.
- LINA repeats the check whenever the manifest changes.

### Notebooks in a LINA conversation

- Attach: the person attaches a notebook to a conversation. LINA answers with its own engine over the notebook's scope, read from the vault, so the feature works when RUMI is not running. The person chooses between notebook sources only and notebook sources with LINA's memory. The answer marks document evidence apart from memory evidence.
- Save to notebook: an answer, a library material or a memo goes into the vault as a new file in `inbox/` that names the target notebook.
- Open in RUMI: a citation opens the RUMI app at the same passage anchor. This is a hand-off between apps, not a call into RUMI.

The screens for these actions are defined in [surfaces.md](surfaces.md).

### Mailbox writes

LINA writes to a vault only in its mailbox and, within grant, in existing notes. It never writes `notebooks/`, `sources/`, `.rumi/manifest.json`, `.rumi/records/`, `.rumi/proposals/`, `.rumi/index/` or `.rumi/local/`.

- `inbox/` receives meeting notes, answers saved from a conversation and library files. Each one is a new file. Its front matter names the LINA asset id and revision, the sender, the time it was made, the target notebook when one was chosen, the conversation or meeting it came from, and the passage anchors of its citations. A non-text file goes in with a Markdown companion that carries the front matter. The exact keys belong to the vault format in [rumi.md](https://github.com/thisisjun786/rumi/blob/dev/docs/design/rumi.md). LINA never overwrites or deletes a file in `inbox/`. RUMI files each item as a note or a source card: an item with no target notebook goes where the vault's inbox rules put it, and a non-text file with its companion becomes one source card.
- `.rumi/inputs/` receives the three input kinds of [host-protocol.md](host-protocol.md). LINA writes a `focus` input when its judgment of what matters now changes, a `request` input when it hands research to RUMI (see "Research through RUMI"), and a `source_deleted` input when it permanently deletes a LINA material it had handed to the vault. RUMI treats them as input, for example to rank its digest or to start a brief.
- Every mailbox write is one commit that contains only the files it adds, with the author settings of Ownership. It is an effect under a grant, recorded with an idempotency key. If the outcome is unknown, LINA looks for the commit in the vault before anything else and never writes again blindly. Effect states are defined in [host-protocol.md](host-protocol.md).
- The vault owns what LINA puts there. LINA's later deletion of the original doesn't remove the vault copy (see Deletion propagation).

### RUMI records

RUMI reports to LINA only through `.rumi/records/`. There are six record kinds: add, merge, split, mark, delete and brief. Each record is an envelope with a RUMI payload ([host-protocol.md](host-protocol.md)) that names the commit which made the change.

LINA accepts a record only after all of these checks pass:

1. The manifest declares a supported combination.
2. The record validates against the schema of the version it declares.
3. The commit it names exists in the vault.
4. The files and `rumi_id` values it names match that commit.

A record that fails a check is not taken. LINA keeps the refusal with its reason and reports it.

An accepted record is a sibling record: external evidence with provenance (vault, record id, commit and observation time). It is never a receipt, an approval, an instruction, a fact about the person or a persona change. Its standing as evidence is defined in [main-authority.md](main-authority.md).

| Record | What LINA does |
| --- | --- |
| add | Records the new note or source card. When it came from an item LINA put in `inbox/`, links the two and shows, as a RUMI card, that RUMI placed it in its notebook. |
| merge | Follows citations and collection membership from the merged notes to the resulting note as lineage. The merged notes are not served as independent evidence. |
| split | Follows citations and collection membership from the split note to the resulting notes as lineage |
| mark | Shows RUMI's mark, such as stale, contradicted or original deleted, on the material, attributed to RUMI |
| delete | Applies the deletion rules below |
| brief | Links the brief to its request and to the conversation or task that asked for it, and shows it as a RUMI card (see "Research through RUMI") |

Every item LINA puts in `inbox/` and every `request` gets exactly one result record from RUMI ([host-protocol.md](host-protocol.md)). A `refused` or `failed` record is taken with the same checks, and LINA shows its cause where the input came from.

LINA is the only speaker in a LINA conversation. RUMI's results appear only as labeled RUMI cards, and LINA never re-voices them, as [product-families.md](product-families.md) requires. RUMI's digest reaches LINA through the `add` record RUMI writes for the digest note; LINA takes it like any record and shows the digest as a RUMI card in the today feed ([surfaces.md](surfaces.md)).

### Research through RUMI

RUMI is the sibling for knowledge work. LINA hands research and organizing to RUMI the way it hands coding to a worker ([work-and-delegation.md](work-and-delegation.md)).

1. LINA writes a `request` input to `.rumi/inputs/` with the question and the target notebook, an existing one or a new one.
2. RUMI gathers, reads and organizes sources for the question inside that notebook and returns a cited brief as a `brief` record ([rumi.md](https://github.com/thisisjun786/rumi/blob/dev/docs/design/rumi.md)).
3. LINA accepts the record with the checks in "RUMI records". The brief and its cited passages are a sibling record, which LINA may use as evidence in its answers with their citations.

- Context stays separate. The sources stay in the notebook, and LINA takes only the brief and its citations into its context. The person can still attach the whole notebook to a conversation (see "Notebooks in a LINA conversation").
- LINA shows the brief as a RUMI card with "Open in RUMI", which opens the notebook in the RUMI app, where the person can continue ([surfaces.md](surfaces.md)).
- Until an accepted brief arrives, LINA shows the request as waiting for RUMI. A `refused` or `failed` record for the request ends the wait, and LINA shows its cause.

### Independence

- LINA and RUMI never call each other's API while running. The vault is the only point of contact.
- LINA keeps every materials function without RUMI, and RUMI keeps every function without LINA. Disconnecting the vault removes only the vault's presence in LINA.
- Each product keeps its own regenerable index of the vault. Neither reads the other's.
- RUMI's processes count as background load under [non-competition.md](non-competition.md).

## Meeting notes

Turning a recording into a meeting note is built in. It needs no extra install or setup.

- The input is an uploaded recording or a recording made in LINA APP. Both are imported materials.
- Transcription runs on the pinned local transcription component by default, with no key. An external transcription API is an optional path ([runtime.md](runtime.md)). Without transcription, only meeting notes are unsupported.
- LINA produces a transcript with the time of each utterance, as derived data of the recording, and a meeting note, as a versioned LINA material, with decisions, owners and due dates linked to their moments in the transcript.
- After the person confirms them, the decisions and owners become tasks ([work-and-delegation.md](work-and-delegation.md)) and commitments in memory ([conversation-and-memory.md](conversation-and-memory.md)). Before the next meeting, LINA summarizes what is still open.
- When a RUMI vault is connected, LINA puts the meeting note into the vault's `inbox/`. The vault copy belongs to the vault. The recording and the transcript stay LINA materials.

## Deletion propagation

These rules apply to materials. Forgetting a memory item and deleting a conversation are defined in [conversation-and-memory.md](conversation-and-memory.md); neither deletes a material. A memory item or a past answer that cites a deleted material shows that citation as deleted evidence (see "Background processing and evidence").

### Inside LINA

- Revoking a material makes its exposure zero in search, answers and LINA APP. Saved versions keep their history and LINA never rewrites it for a revocation. Past answers keep the revision they cited and show it as revoked evidence.
- Deleting a material moves it to the trash for 30 days, where it can be recovered and is exposed zero times. After 30 days it is permanently deleted.
- The person can choose immediate permanent deletion. That choice is the approval for an unrecoverable deletion ([main-authority.md](main-authority.md)).
- Permanent deletion removes every copy LINA manages: the current bytes, the saved versions in the version space, derived data, copies on registered Nodes and remote copies LINA manages. It is the only operation that alters saved-version history. It leaves a tombstone with the asset id, what was removed and when, and no content. A Node that is unreachable applies the deletion while it reconciles, before any new work. Backup generations are never rewritten; how a restore applies the tombstone, including one recorded after the latest generation, and when the content leaves the backups, is defined in [filesystem.md](filesystem.md).
- Permanent deletion doesn't reach exported files, copies handed into a sibling's mailbox or copies other people hold. LINA says so when the person deletes.
- When a permanently deleted material had been handed into a RUMI vault, LINA writes a `source_deleted` input to `.rumi/inputs/` so RUMI can mark the notes that came from it.

### At a connected source

- When an observation shows that a file is gone from a connected source, LINA stops exposing it at once and deletes the derived data it holds for it. The asset record stays, so past answers can name it as deleted evidence.
- Saved versions LINA kept of that file follow the trash rule: recoverable for 30 days, then permanently deleted.
- In a Git source the file stays in the source's own history. LINA never serves it from that history.
- In a RUMI vault, a delete record and LINA's own observation settle the deletion together. Whichever arrives first stops exposure; the record adds RUMI's reason and lineage.

### Disconnecting and restore

Disconnecting a source follows [filesystem.md](filesystem.md): derived data is deleted, exposure stops and asset records stay. A restore applies revocations and tombstones again before serving any read, as [filesystem.md](filesystem.md) requires.

## Deferred

- Screen design for the library, meeting notes, notebook actions and RUMI cards: set while building each surface of the LINA app, per [surfaces.md](surfaces.md).
- The order in which media types gain derived data, and the rebuild schedule: set during materials implementation acceptance.
- The viewer for each document type: set during materials implementation acceptance.
- How often LINA writes `focus` inputs to a vault: set during implementation acceptance of the vault link.
