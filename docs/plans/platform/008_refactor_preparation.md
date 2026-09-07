# Installation and complete state history

Status: product requirements with a partial implementation. Current code provides portable home resolution, separate releases, owned/shared Codex tasks, offline local checkpoints and staged recovery. Automatic growth history, selective restoration, external-service export and native macOS/Windows acceptance remain follow-up work. See [installation contracts](../installation.md) and [current runtime](../../CODEX_RUNTIME.md).

## Product compositions

1. Installable Lina on macOS, Linux and Windows: personal agents, conversations,
   memory and Codex work management without requiring a desktop VM.
2. Add a dedicated computer for independent GUI work, locally or remotely.
   Present this as a workspace capability; disclose VM resource use, guest OS,
   shared folders and login boundaries before provisioning.
3. Lina OS composes the full service and desktop environment at installation.

Isolation is an independent axis: direct execution, isolated task execution,
or a containerized whole-Lina installation. Dedicated GUI sessions do not by
themselves prove security isolation. A container without a desktop can still
serve isolated coding jobs. Host access remains an explicit capability.

Native Mac application work targets the Mac connector. Dedicated Linux desktop
work targets a Linux runtime. One login reusable by new agents and concurrent
GUI input remain required experiments, not guarantees supplied by a VM.

## Installation and persistence contract to implement

- One Lina home: explicit LINA_HOME, otherwise the current user's ~/.lina.
  Resolve it independently of process cwd and without rewriting HOME/CODEX_HOME.
- Separate executable releases, shared state, per-agent state, credentials,
  skills, workspaces, cache and logs under the selected home.
- User workspaces may point outside that home. Path organization is not access
  control. External Codex/OpenCodex/OpenViking state needs an ownership manifest;
  a Lina-home backup alone must not claim to include externally owned history.
- OS-specific launcher/service registration may live outside the home.
- Updates replace executable releases without overwriting user data. Database
  compatibility, backup consistency and restore are explicit operations.
- Existing LINA_STATE_DIR installations need defined precedence and a migration
  preview. Never silently start a fresh agent because a path changed.
- Credentials and sensitive state are private; logs and support exports are
  redacted. Whole-container mode must not grant ambient host execution through
  a shared Codex socket, a container-management socket, or broad host mounts.

## Complete agent state versioning requirements

Requirement: version the complete persona, memory and agent configuration, plus
associated user profiles. The scope includes all of these components together.
An agent checkpoint must bind these components to one restorable manifest;
independently versioned files without a coherent checkpoint are insufficient.
Proposed design: transactional stores own accepted revisions; a private local Git
repository under LINA_HOME/history records deterministic human-readable snapshots
and checkpoint manifests. Git is a history/export view, not a second independently
writable authority. Large or database-native snapshots use private content-addressed
artifacts referenced by the manifest, with verified availability and checksums.
No repository initialization or remote publication is performed by this note.

- Version authored identity separately from learned interests, preferences and
  relationships. Existing policy keeps core personality user-authored and stable.
- Scope user profiles by user ID, personas by agent ID, and relationship state by
  both IDs. Avoid accidentally sharing one user's relationship with another.
- Include persona fields and their dynamic state; memory records, provenance,
  corrections and retractions; model/role settings, prompts, skills and tool
  configuration, access policies, workspace bindings and schedules. Record skill
  versions/content digests and necessary custom content, not paths alone.
- Capture transient mood with its expiry; restoration must not revive expired
  state. Preserve tentative memory status rather than promoting it to fact.
- Raw conversation evidence, external memory stores and runtime databases need
  explicit checkpoint/export coverage. Keep binary/raw payloads outside Git if
  appropriate, but never exclude them from recovery accounting silently. Rebuildable
  indexes/cache are marked as such. Credentials use separately protected backup
  or reauthentication requirements, never plaintext Git history.
- Each accepted revision records actor (user/agent/import), reason, timestamp,
  schema version, prior revision and opaque evidence references. Store sensitive
  evidence in its authorized source store, not in Git commit messages.
- Commit authored edits immediately through a durable export queue; batch
  accepted growth checkpoints. Serialize Git writes with stable revision IDs,
  recover pending exports after a crash, and report export lag or failure.
- Manual file edits are validated import proposals. They do not bypass identity
  ownership, schema checks or expected-revision concurrency control.
- Offer selective component restoration and full-agent restoration as NEW
  revisions. A full restore uses the manifest's consistent component versions and
  drains/fences active writers; it is not a reset of an entire shared repository.
  Define conversation continuation explicitly so newer turns cannot silently
  repopulate reverted memories. Never replay completed external actions or revive
  old running jobs. Revalidate restored permissions, host bindings and schedules
  before execution. Regenerate prompt projections and invalidate caches.
- Templates shipped with Lina and a user's adopted persona are distinct. A
  software/template update must not overwrite personal growth or authored edits.
- Default history is local and private. Remote backup/sync is an explicit later
  feature; avoid automatic merges of conflicting identity/relationship changes.
- Forget/delete is different from rollback: historical Git objects, exports,
  backups and any remote copies require an explicit retention/purge policy.
  A new deletion commit is not proof of erasure. Avoid promising complete deletion
  from uncontrolled copies. A local history is also not an off-device backup.

Acceptance: persona, memory and settings changes produce attributable revisions;
full checkpoints identify exact source revisions and all required artifacts;
tentative state remains tentative and expired mood stays expired; concurrent
updates reject stale revisions; export failure recovers without losing accepted
updates; selective restoration preserves unrelated state; full restoration fences
writers and does not replay actions. Shared user/project memory is restored only
under explicit shared scope, never silently rolled back for all agents. External
stores lacking export/restore support are reported as an incomplete checkpoint,
not a full backup. Forgetting is tested against every owned history/projection.
Database/Git consistency and privacy make implementation C4.

## Acceptance ownership

Use focused failing tests for behavior changes, then source gates. Portable installation requires clean install/upgrade/uninstall with user data preserved on each supported platform. Container claims require explicit mounts, resource/network policy and persistent restart tests. Dedicated computers require [input-ownership and recovery tests](001_runtime_contracts.md), including shared-login feasibility and independent input. The OS distribution consumes a pinned product release and owns guest installation and recovery acceptance. Publication is a separate owner decision under [publication preparation](../../PUBLICATION.md).
