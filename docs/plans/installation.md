# Installation, checkpoint and recovery contracts

Status: current local installation/checkpoint behavior plus acceptance requirements. Automatic semantic history, selective live restoration and external-service exports are planned in [complete state history](platform/008_refactor_preparation.md). Test results for a release belong to that exact release's evidence, not this requirements document.

## Paths and releases

Resolve `LINA_HOME` explicitly or use the current user's `~/.lina`, independently of cwd and without changing `HOME` or `CODEX_HOME`. Reject empty or relative homes. Explicit legacy `LINA_STATE_DIR` takes precedence for state only; legacy relative state paths resolve from cwd. Existing bindings own their canonical workspace; a conflicting requested workspace needs migration guidance. Do not silently adopt an old implicit state directory or create a fresh identity because a default path changed.

Separate release resources, shared/per-agent state, credentials, skills, workspaces, history, logs and cache. Resource lookup comes from the installed release, including prompts, presets and avatars. Managed writable notes belong to state. External workspaces are allowed and explicitly accounted for. Executable updates prepare dependencies before switching the current release pointer; failure preserves the previous pointer and user data. Running processes keep their loaded release; new starts select the updated one.

The installer and runtime-state writers use separate locks. Runtime startup and checkpoint capture cooperate on installation ownership; checkpoint capture also acquires each actual agent/session lease before enumerating data. Locks release on process death. Owned Codex tasks use a dedicated home/configuration and supported provider environment. Shared mode retains the chosen daemon binding and must never tear down the external daemon or silently switch engines.

## Offline checkpoints

Capture local persona, memory, settings, profiles, introduction data, custom prompts and skills under one immutable manifest. Records include component, path, content hash, size, timestamp and coverage gaps. Payloads are private content-addressed objects. Optional Git export at `history/vcs` contains manifest metadata only and does not automatically create a remote or push.

Offline capture needs a writer barrier. Preserve SQLite main files together with nonempty WAL files; account for omitted regenerable SHM files. Exclude owner/lease files. Reject changed sources, traversal, symlinks, hardlinks and special files. Include source/content revisions for skills rather than relying on paths alone. Credentials require separate protected backup or reauthentication; generated credential-bearing configuration must not enter Git payloads or messages.

List, verify and diff manifests. Report external Codex/OpenCodex/OpenViking/Honcho state, workspaces, credentials and unsupported exporters as coverage gaps; a home snapshot is not a full external backup. Unknown or missing artifacts prevent a complete recovery claim.

## Recovery and acceptance

Restore only into a new target and mark it for review before startup. Recheck absolute paths, bindings, headers, permissions, external service links and schedules. Do not overwrite the active installation, replay completed external actions or revive old running jobs. A later activation/migration must explicitly resolve the review marker.

Tests cover arbitrary cwd and spaced paths, home/state precedence, invalid values without filesystem mutation, saved workspace conflicts, dependency-preparation failure, preserved release pointer, same IDs after restart, crashed SQLite WAL recovery, killed checkpoint writer recovery, tampered objects, unsafe paths and nonempty restore targets. Git export must ignore inherited routing, hooks and signing configuration and commit only the requested manifest.

The product compositions are native Lina, Lina with a dedicated local/remote computer, and an OS distribution consuming a pinned release. Security isolation is separate from per-agent folders or a GUI session. Whole-runtime containers must not acquire ambient host access through broad mounts or daemon/management sockets. Native macOS/Windows, containers, independent GUI input, shared-login reuse, guest install and recovery each need their own artifact/environment acceptance. Source tests do not establish those results.
