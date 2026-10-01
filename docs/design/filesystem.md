# Common filesystem

This contract fixes the filesystem under the main LINA Core: the state root and its layout, who writes each area, how a material keeps its identity, where versions and derived data live, how LINA reaches a person's folders and repositories without copying them, how material enters and leaves LINA, and what a backup generation holds. It is normative: implementations must follow it, and any change to it goes through a pull request against this file. Runtime proof belongs to the implementation issues that consume it.

## Scope

The main LINA Core keeps its state on a Linux filesystem, whether LINA OS is the device operating system, LINA OS runs in a VM, or LINA Core runs on a general Linux system. Every install uses the same relative layout. The installation mode changes where the layout is mounted, never its shape. Installation modes are defined in [product-families.md](product-families.md).

A Node keeps only its own execution state: the grants it holds and the receipts it has not yet delivered. It never holds canon, materials or a version space. Grants, receipts and provenance are defined in [main-authority.md](main-authority.md).

This contract covers:

- the state root, its areas, and the writer and backup unit of each area
- the rules for every write outside the state root
- asset identity: asset id, revision, content hash, observed path and declared external keys
- connected sources: how LINA reaches a person's folders and repositories without a copy
- the version space
- the split between original bytes and derived data
- import and export
- backup generations and restore

What LINA does with materials, how the library presents them, editing a person's files in place, the RUMI vault and deletion propagation are defined in [materials-and-knowledge.md](materials-and-knowledge.md).

## State root and layout

There is one state root per main, written here as `<state-root>`. Every path below is relative to it.

| Area | Relative path | Holds | Writer | Backup unit |
| --- | --- | --- | --- | --- |
| Canon | `identities/<identity-id>/canon/` | LINA Core's SQLite canon: identity, ledgers, memory, materials metadata, the connected-source registry, the plugin registry, standing grants, and derived indexes | LINA Core | Personal generation |
| Version space | `identities/<identity-id>/versions/` | Local Git repositories for versionable text and metadata | LINA Core | Personal generation |
| Imported materials | `identities/<identity-id>/materials/user/<asset-id>/<revision>/` | Bytes of material a person handed to LINA, when they are not kept in the version space | LINA Core | Personal generation |
| LINA materials | `identities/<identity-id>/materials/lina/<asset-id>/<revision>/` | Bytes of LINA's own outputs, when they are not kept in the version space | LINA Core | Personal generation |
| Derived data | `identities/<identity-id>/derived/<asset-id>/<revision>/` | Regenerable descriptions, transcripts, structure and indexes | LINA Core | Personal generation, recorded by source revision |
| Conversation workspace | `identities/<identity-id>/workspace/` | The working directory of conversation tools | LINA Core conversation tools, inside the sandbox | Personal generation |
| Parent clones | `identities/<identity-id>/work/clones/<clone-id>/` | Clones of the repositories that work runs against | LINA Core | Not in the personal generation |
| Task workspaces | `identities/<identity-id>/work/tasks/<task-id>/` | The worktree or the non-Git work directory of each task | The worker of that task, inside its grant | Not in the personal generation |
| Import staging | `identities/<identity-id>/staging/import/` | Material on its way in | LINA Core | Not backed up |
| Export staging | `identities/<identity-id>/staging/export/` | Material on its way out | LINA Core | Not backed up |
| Installation state | `system/` | Install configuration and component events | The install and each component's event writer | OS root snapshot, where the install has one |
| Secrets | `secrets/` | LINA's secret store when no OS keychain is available: tokens and API keys of plugins, Google client credentials and LINA's other secrets, each file with mode 0600 ([integrations.md](integrations.md)) | LINA Core | Not backed up |
| Backup generations | `backups/<identity-id>/<generation-id>/` | Personal generations | The backup procedure | Is the unit |
| Removal list | `backups/<identity-id>/removals` | Every retraction, trash recovery and tombstone of the identity, appended as each happens | LINA Core | Beside the generations, in none of them |

Rules for the layout:

- Only LINA Core writes canon, the version space, the materials areas and derived data. LINA APP, Node, sibling products, the library view and generic file tools never write there.
- Conversation tools write only in the conversation workspace and in the scope of their grant. The sandbox that enforces this is defined in [runtime.md](runtime.md).
- The work area is everything under `identities/<identity-id>/work/`. What clones and task workspaces contain, and how long they are kept, is defined in [work-and-delegation.md](work-and-delegation.md).
- Backups live at `backups/<identity-id>/<generation-id>/`, beside the identity tree, never inside it. A generation must not be captured by the tree it backs up.
- Configuration and secrets have their own writers. They never live under `canon/`, `versions/`, `materials/` or `derived/`. LINA's secret store is the OS keychain where one is available, and `secrets/` otherwise.
- Sibling products keep their own state outside `<state-root>`. LINA never hosts a sibling's canon.
- Renaming any directory in this table is a contract change, made by a pull request against this file.

## Writes outside the state root

Every write LINA makes outside `<state-root>` is an effect under a grant whose scope names the target, checked before the effect as [main-authority.md](main-authority.md) requires. On top of that:

- Export leaves only through `staging/export/`, to a destination the person chooses.
- An edit to a file in a connected source follows the in-place editing rules in [materials-and-knowledge.md](materials-and-knowledge.md).
- A write into a sibling's mailbox adds new files only. The RUMI vault mailbox is defined in [materials-and-knowledge.md](materials-and-knowledge.md).
- LINA's own secrets in the OS keychain are its secret store, not a write to a person's files.

## Asset identity

Every material carries an asset id. The asset id, the revision, the content hash and the observed path are distinct values, and the system never derives one from another.

- A rename or move changes only the observed path. The asset id and the content hash stay the same.
- An edit keeps the asset id. The revision advances and the content hash changes.
- Two files with identical content get two asset ids. A matching hash never merges them, and a matching name or path never merges them either.
- After a move or a rename the material is still found by its asset id, so collections, relations and citations don't break.

An asset id is assigned when LINA first records a file: at import, when LINA produces it, or when LINA first observes it in a connected source.

The revision depends on where the bytes live:

| Where the bytes live | Revision |
| --- | --- |
| Version space | The commit that holds that version |
| Imported or LINA materials area | The revision directory |
| Connected source that is a Git repository | The commit, together with the file's blob hash. Working-tree content that differs from the commit is observed by content hash and observation time and marked uncommitted. |
| Connected source that is not a Git repository | The content hash and the observation time |

### Renames

LINA treats two paths as the same asset only on one of these grounds:

- a move LINA itself performed
- a move event the filesystem reported to the observer, which is LINA Core for local sources and the Node of the device for sources on that device
- a declared external key, under the rule below

Similarity-based rename detection, such as Git's, matching hashes and matching names never establish that two paths are the same asset. When none of the grounds applies, the asset at the old path is recorded as gone and the file at the new path gets a new asset id.

### Declared external keys

A connected source may declare a key that its owner keeps stable across renames. The RUMI vault declares `rumi_id` in note front matter; its rules are in [rumi.md](https://github.com/thisisjun786/rumi/blob/dev/docs/design/rumi.md).

- LINA records the declared key with the asset.
- LINA follows a rename by the key only when exactly one file in the same connected source carries that key at the observed revision.
- When two or more files carry the same key, LINA ignores the key for all of them and identifies each file by the other grounds until the duplication is resolved by the source's owner.
- Keys are never compared across connected sources.
- LINA never assigns, edits or removes a declared key.

### Files on Node devices

A reference to a file on a Node device carries the provenance fields of [main-authority.md](main-authority.md): the asset id as the artifact id, the task id, the node id, the observed path, the revision and content hash, and the observation time. Such a reference is valid only under a current grant from the main. A stale grant makes the reference unusable until the file is observed again. Name, path or identical content alone never prove that two files on different devices are the same file.

## Connected sources

A connected source is a folder or repository that stays where the person keeps it and is visible to LINA without a copy. There are three kinds:

- folder
- Git repository: a folder whose root is a Git work tree
- RUMI vault: a Git repository whose root holds `.rumi/manifest.json`. LINA's rules for it are in [materials-and-knowledge.md](materials-and-knowledge.md).

A repository that a goal connects for development work is not a connected source. It follows [work-and-delegation.md](work-and-delegation.md) and [integrations.md](integrations.md).

The library scope is the set of connected sources. It is the scope that conversation tools read by default, as defined in [runtime.md](runtime.md).

### Connecting

- Nothing becomes a connected source unless a person connects it. LINA never connects a folder on its own. A folder being visible to the machine or to a Node doesn't make it a connected source.
- The act of connecting is the approval. Connecting adds the source to the default grant for reading. There is no separate import step and no per-file approval.
- On LINA OS, the person's data area on that device is offered as one connected source when the person sets up the device. On a general Linux main and on every device with a Node, the person connects the folders they choose.
- Connected sources do not overlap. Connecting a folder that lies inside an existing connected source makes it its own source, and the outer source excludes it. A file belongs to at most one connected source.
- Nothing under `<state-root>` is ever a connected source.

### Reach

| Where the source lives | Who reads and writes it |
| --- | --- |
| The LINA OS main device | LINA Core, locally |
| The machine of a general Linux main | LINA Core, locally |
| A device with a Node: a desktop install on Linux, macOS or Windows, or the host of a VM install | The Node of that device, under a grant from the main |

Whatever device holds the files, the materials metadata, observed revisions and derived data of every connected source live on the main.

### No copy

- LINA never copies a connected source into a materials area. The bytes stay with the person.
- LINA keeps on the main only asset records, observed revisions, derived data and the saved versions of its own edits.
- When the source is a Git repository, its commits are the revisions. LINA keeps no second history of it.
- When the source is not a Git repository, the saved versions of LINA's own edits live in the version space. LINA never creates a repository inside a person's folder.

### Observation and state

LINA observes each connected source to learn about new, changed, moved and deleted files. Every observation records the revision and the observation time.

A connected source is in exactly one state:

| State | Meaning |
| --- | --- |
| connected | LINA can observe the source now |
| unreachable | The source exists but LINA can't observe it now: its Node is disconnected, its path is missing, or the observer lacks permission |
| disconnected | The person disconnected it |

While a source is unreachable, LINA may answer from derived data of the last observed revision and marks that evidence with its observation time. It never presents that evidence as current. How the library shows each state is defined in [materials-and-knowledge.md](materials-and-knowledge.md).

### Disconnecting

The person can disconnect a source at any time. On disconnect, LINA:

- stops reading and writing the source at once and cancels writes to it that haven't started
- deletes the derived data it built from the source
- stops exposing the source in search, answers and LINA APP
- keeps the asset records in canon, marked disconnected, so past answers can still name the evidence they used

Reconnecting the same folder is a new connection. Asset identity carries over only through declared external keys.

## Version space

The version space is a set of local Git repositories under `versions/`. It holds every versionable text and metadata of LINA: documents and pages, document projects, notes, meeting notes, imported text, and the saved versions of LINA's edits to connected sources that are not Git repositories.

- Large binaries and media stay outside Git, in the materials areas, linked by content hash.
- The SQLite canon and fast-changing state stay outside Git.
- Each material has exactly one byte store: the version space for versionable text, or a materials area for everything else. Canon records which one.
- Structured fields of goals and plans live in canon, not in Git. Their rules are in [work-and-delegation.md](work-and-delegation.md).
- The version space never holds the history of a connected Git repository. It refers to that repository's commits.

How versions appear to the person is defined in [materials-and-knowledge.md](materials-and-knowledge.md).

## Originals and derived data

Original bytes live in the version space, in the materials areas or in connected sources. Metadata and derived indexes live in canon.

Derived data (descriptions, transcripts, structure and indexes produced from images, audio, video and documents) never lives inside an original's directory and never inside a connected source. It lives under `derived/`, linked to its source by asset id and source revision, so the link survives when the original moves.

Derived data is regenerable. It's rebuilt from its source when the source revision changes, and it must never become the only copy of anything.

A sibling's own index, such as the RUMI vault's `.rumi/index/`, is not LINA's derived data. LINA never reads or writes it and builds its own.

## Import and export

An import is a person handing material to LINA: an attachment in a conversation, an upload, a recording made in LINA APP, a file dropped into the library, or a capture saved from a connected service under a grant. Handing the material over is the approval.

- Imports go through `staging/import/`. The item receives an asset id, is placed in its byte store (the version space or `materials/user/`) and is recorded in canon.
- The original stays where it was and stays the person's.
- An import is a copy. LINA never imports a file from a connected source in order to read it. A person may still import a copy of such a file; the copy is a new asset.

Exports go through `staging/export/` only, to a destination the person chooses. An exported file leaves LINA's management: a later deletion in LINA doesn't reach it.

A file LINA writes into a sibling's mailbox is a handover of the same kind. The sibling's repository owns that copy.

## Backup generations

A backup generation captures one identity's canon, version space, materials areas, derived data and conversation workspace at one point in time, so that a restore never leaves them out of step.

Connected sources are not in a generation. They belong to the person and have their own recovery. The generation holds their registry and observed revisions as part of canon, never their bytes. The work area is not in a generation either.

A generation manifest records:

- the schema version of the manifest itself
- the generation id and the identity id
- the created-at time
- the artifact versions and schema versions in use when the generation was taken
- the SQLite snapshot: relative path, hash and revision
- every version-space repository: relative path and head commit
- every asset in a materials area: asset id, revision, relative path, hash and size
- the source revisions of the derived data included
- the revocation watermark at capture time

The backup procedure must:

1. Quiesce writers.
2. Take a consistent SQLite snapshot with the online backup API. Copying database and WAL files is never a backup.
3. Record the head of every version-space repository, copy the repositories and the asset bytes, and verify every hash against the manifest.
4. Publish the manifest last. A generation without a published manifest doesn't exist.

Restore rules:

- Restore operates on whole generations. Restoring the SQLite snapshot without its version space and assets, or those without the snapshot, is forbidden.
- Restore uses a compatible release and schema pair. Rolling back binaries alone over state they can't read is forbidden ([runtime.md](runtime.md)).
- Identity, receipts, artifacts and ledgers are restored first. Then the latest revocation watermark, and every retraction and tombstone recorded in canon, in any newer generation or in the removal list, are applied again before any read is served. A tombstone is the record a permanent deletion leaves: ids and time, never content. Revoked and deleted items are exposed zero times in search or answers, and a memory tombstone keeps the restored conversation ledger from yielding the forgotten item again ([conversation-and-memory.md](conversation-and-memory.md)).
- Engine thread history and work-area state that the generation does not hold are marked as not restored.
- Restore checks the freshness of the generation and an inventory of what it restored that is independent of the manifest.
- After a restore, LINA observes every connected source again before serving from it. Observations newer than the generation win.

A published generation is never changed, and a permanent deletion never rewrites one. A generation captured before the deletion still holds the deleted content. A restore from it applies the tombstone again before serving any read, as above, so the content is never exposed, and the content is gone once every such generation has passed its retention and been removed.

Every retraction, every recovery from the trash and every permanent deletion is also appended to the removal list at `backups/<identity-id>/removals`, beside the generations and outside every one of them. The list is append-only and holds ids, kinds and times, never content. A restore reads it with the generation, so an item forgotten or deleted after the latest generation stays hidden when canon is lost, including an item still in its 30 days in the trash, and an item recovered from the trash comes back. Generations move between machines only whole, together with the removal list.

On LINA OS, the OS root snapshot, the boot configuration, the person's home data and LINA's personal generations are distinct recovery units. An OS root snapshot doesn't include the person's home data and is never a LINA Core restore. `system/` follows the OS root snapshot; the identity tree follows the personal generation. Neither stands in for the other. The update and rollback procedure that uses these units is defined in [runtime.md](runtime.md).

## Deferred

- The location of a Node's execution state on each OS: set during packaging implementation acceptance, together with the absolute `<state-root>` and the other paths deferred in [runtime.md](runtime.md).
- Which text formats count as versionable, and the file size above which bytes stay outside Git: set by measurement during materials implementation acceptance.
- The observation cadence for connected sources, and which move events each OS reports to the observer: set during Node and materials implementation acceptance.
- Backup cadence, retention and size limits: set during implementation acceptance.
- Fault injection during SQLite writes and backups, and the restore measurements that prove hash and reference integrity of one generation: set during implementation acceptance.
