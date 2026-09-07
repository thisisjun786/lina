# Validation scope

This page defines reproducible checks and acceptance boundaries for a source revision. Record results for the exact code and environment tested, and limit release claims to that evidence. [PUBLICATION](PUBLICATION.md) covers source review and publication requirements.

## Source checks

Use the Bun version in [.bun-version](../.bun-version) and the committed lockfile. Linux document tests require Poppler, Python and `prlimit`; setup instructions are in [CONTRIBUTING](../CONTRIBUTING.md).

```sh
bun test
bun run typecheck
bun run lint
bun run ci:validate
bun run ci:build
bun scripts/ci/audit.ts
bash scripts/ci/secrets.sh
```

The history scanner requires readable Git history; an empty or incomplete scan is not proof of a clean history. Inspect the final tracked files and metadata as well as the commits being published. Dependency auditing queries the configured advisory source. Source tests use synthetic temporary data and local fakes; they do not qualify live model services.

Record the exact source revision or file digest set, command, exit code and material warnings with each result. Failed, skipped and unrun checks remain distinct. Hosted checks validate their combined merge candidate; local results do not activate GitHub protections.

## Acceptance boundaries

| Capability | Required proof |
| --- | --- |
| Conversational setup | New/existing users, failed-text and same-ID recovery, confirmed-only sharing, one-time guidance, restart and actual developer input; [contract](plans/onboarding.md) |
| Durable chat and memory | Ordered original entries, duplicate prevention, source-linked compaction, failure recovery, persistence and later scoped recall; [runtime](CODEX_RUNTIME.md) |
| Codex tasks | Same native task ID for reads/input/stop/approval, correct owner/revision, reconnect without blind replay, owned/shared lifecycle separation |
| Local install and checkpoints | Out-of-checkout launcher, failed-upgrade pointer preservation, offline SQLite/WAL capture, private payloads, integrity checks and staged recovery; [contract](plans/installation.md) |
| UI and attachments | Desktop/mobile keyboard and focus, drafts and scroll, actual file bytes, supported MIME/size errors, reconnect and browser console/network evidence |
| Provider compatibility | Exact Codex/OpenCodex service versions, engine × API × model, capability, real input/output, persistence and restart where promised |
| Container packaging | Built image digest, nonroot/read-only configuration, explicit volumes, absent ambient host sockets, persistent restart and notice inclusion |
| Native desktop and dedicated computers | Packaged app on each OS, real clipboard/IME, independent input, takeover fencing, shared-login feasibility and recovery |
| OS integration | Pinned Lina release, fresh guest installation, boot, resource admission, restart and restore |

Live scripts under [scripts/qa](../scripts/qa) may require accounts, inference and isolated workspaces. Inspect each script before an authorized run. Use separate state, credentials, sessions and service volumes, not only a separate source checkout. A health response, catalog row, saved setting or successful upload does not prove model execution, recall, client behavior or complete recovery.

## Documentation and provenance

Check local Markdown targets and section anchors in changed documents. Persona source records keep the original `sha256` and verify current bytes against `currentSha256`; use the [reproducible check](PUBLICATION.md#reproducible-documentation-checks) for persona, avatar and icon digests. Preserve image and license bytes. Review identifying strings in context: synthetic examples, loopback/default configuration and public third-party attribution differ from personal environment records.

Automatic semantic history, selective live restore, external-service export, the Electron redesign, multi-message delivery, clipboard additions, desktop provisioning, image integration and the world/feed engine require their own implementation evidence. Planning documents are acceptance requirements, not evidence that these features ran.

## Upgrade checks

For [existing Honcho installations](../deploy/honcho/README.md#agent-scopes-and-readiness),
verify that upgrades retain the configured user peer ID and reject an ID that
aliases the agent observer. Source installation does not migrate external memory
data; test any migration separately within its authorized scope.
