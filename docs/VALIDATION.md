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
| LIFE state and context boundary | Paired world/social transaction; exact v1 migration and complete replay; real DB/process restart; private views; authored identity precedence; policy-bound serialized RPC and native epoch recovery; [first-unit evidence](plans/life/010_state_and_views.md) |
| World authoring | Versioned drafts and explicit confirmation, strict replay audit, partial suggestions without guessed settings, deterministic scoped lore/rules, real HTTP/approval execution, qualified native author capabilities and teardown with retained cleanup ownership; [contract and evidence](plans/life/020_world_authoring.md) |
| Social resolution | Pinned isolated Ensemble execution, sequential effect/history validation, immutable seed and durable prepared/result/accepted receipts, scoped knowledge grants, exact migration/restart and installed-worker continuation; [contract and evidence](plans/life/030_social_engine.md). Core validation does not independently reproduce ranking/RNG winner or exact volition cache contents. |
| Autonomous LIFE | Versioned world rules, replayed step/sidecar transactions, lease and usage fencing, actor/target/reflection privacy, real native Codex with synthetic Responses and installed-layout HTTP; [implementation and review record](plans/life/040_autonomous_life.md). Independent code reviews passed; final candidate checks are recorded separately in that unit. Native transport proof does not establish provider quality or monetary caps. |
| Work, persona and memory sources | Task and taskless resource-activity receipt/inbox recovery; explicit source and destination permission; common authored identity and permitted growth; complete journal episode membership; native memory/context provenance and final dispatch checks; protected binding HTTP and ordinary Codex serialization with memory enabled. See [initial LIFE evidence](plans/life/050_work_and_persona.md) and [current integration](plans/context-engines/071_installation_integration.md). Historical external-adapter tests do not qualify the replacement engines. |
| Shared resource engines | Stable logical references, real content/version storage, source-current search and memory, agent/Codex retrieval without task creation, current visibility after awaits, concurrent revisions, corruption and restart; [contracts](plans/context-engines/004_contracts.md). Fake derivations prove data flow, not extraction or reasoning quality. |
| LIFE publication and feedback | Recipient-filtered event/generated-reply material; immutable claim provenance; live task/grant/role checks; viewer-specific reactions; single model/lease/budget owner; paused recovery without new dispatch; once-only posts, interactions and scoped subsequent experiences; actual DB/Fleet restart and protected Fleet/web-proxy HTTP. See [060 evidence](plans/life/060_publication.md) and [generated reply contract](plans/life/061_reply_contract.md). Native-enabled 2,885-test source gate, 42 curl captures and two independent implementation reviews passed. This does not certify paid-model narrative quality, UI or image attachment. |
| Local install and checkpoints | Out-of-checkout launcher, failed-upgrade pointer preservation, offline SQLite/WAL capture, private payloads, integrity checks and staged recovery; [contract](plans/installation.md) |
| UI and attachments | Desktop/mobile keyboard and focus, drafts and scroll, actual file bytes, supported MIME/size errors, reconnect and browser console/network evidence |
| Provider compatibility | Exact Codex/OpenCodex service versions, engine × API × model, capability, real input/output, persistence and restart where promised |
| Container packaging | Built image digest, nonroot/read-only configuration, explicit volumes, absent ambient host sockets, persistent restart and notice inclusion |
| Native desktop and dedicated computers | Packaged app on each OS, real clipboard/IME, independent input, takeover fencing, shared-login feasibility and recovery |
| OS integration | Pinned Lina release, fresh guest installation, boot, resource admission, restart and restore |

Live scripts under [scripts/qa](../scripts/qa) may require accounts, inference and isolated workspaces. Inspect each script before an authorized run. Use separate state, credentials, sessions and service volumes, not only a separate source checkout. A health response, catalog row, saved setting or successful upload does not prove model execution, recall, client behavior or complete recovery.

## Documentation and provenance

Check local Markdown targets and section anchors in changed documents. Persona source records keep the original `sha256` and verify current bytes against `currentSha256`; use the [reproducible check](PUBLICATION.md#reproducible-documentation-checks) for persona, avatar and icon digests. Preserve image and license bytes. Review identifying strings in context: synthetic examples, loopback/default configuration and public third-party attribution differ from personal environment records.

Automatic semantic history, selective live restore, external-service export, the Electron redesign, multi-message delivery, clipboard additions, desktop provisioning, image integration and the complete LIFE/feed engine require their own implementation evidence. The source-aware memory tests use isolated data; they do not qualify existing installed memory data, real narrative quality, publication or image delivery. Planning documents are acceptance requirements, not evidence that these features ran.

## Upgrade checks

Legacy Honcho selection must report migration required without remote requests or automatic import/deletion. Retain the original external data and settings for an explicitly authorized migration; [the old deployment guide](../deploy/honcho/README.md) is historical. New native memory and shared resources must start without an external Honcho/OpenViking service.

For LIFE native journals, distinguish reading saved completed results from dispatching a prepared request. Reconciliation preserves the original fingerprint and request; new dispatch must match current capabilities. Synthetic journal replay with a removed provider verifies no re-selection or second call, but is not proof that an old executable's pending request can execute after a code upgrade.
