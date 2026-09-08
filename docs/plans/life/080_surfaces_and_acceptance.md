# 080 — Product surfaces, operation and complete acceptance

Status: local implementation and independent review complete, 2026-09-08. Final native-enabled source gate: 3,363 tests, 17,847 assertions, zero failures across 480 files. Root/browser types, lint, build, CI validation and dependency audit pass. Eleven actual health HTTP cases complement the 27 image HTTP cases from 070. This cycle owns engine integration, recovery and explicit UI/image consumer handoff. The bound user goal retains the existing UI/image owners; their renderer and real-provider acceptance remain distinct delivery dependencies. No UI implementation, provider spend, merge or deployment is authorized here.

## Revalidated execution contract

The original surface proposal below remains the UI owner's acceptance specification,
not permission for this task to replace that renderer. Complete the engine-owned
causal story and operational boundaries with executable evidence, and identify
which user journeys need the UI owner and separately configured live qualification.
The goalplan criterion explicitly requires an integrated isolated causal story,
real DB/process restart, source checks, independent review and consumer contracts
with actual-provider proof gaps. No initial world/persona/work/social/image
capability is removed by this ownership clarification.

| Operation / actual path | Diff-level plan and proof |
| --- | --- |
| NEW runtime `test/life-e2e.test.ts` and a fixture only if necessary | One disposable Fleet installation: real task manager with synthetic Codex RPC terminal receipt → explicit work share → accepted event/experience → permitted publication/image → viewer reply → later scoped experience. Assert original task text/secrets do not enter forbidden model/feed/image inputs, authored persona remains intact, same-operation replay and actual store reopen retain IDs/counters. Reuse010–070 contrasts rather than silently replacing their stronger negative cases. |
| NEW runtime `test/life-checkpoint.test.ts`, task-local child fixture under runtime test | Exercise the existing offline checkpoint CLI on actual LIFE WorldStore, AgentStore and image manifests/assets. Refuse an active installation owner; stage restore to a new temporary root; reopen each real owner and verify IDs/hash/receipt/counter retention. Include a real child process termination after a durable LIFE write and recovery from WAL. Change history inventory/barriers only if this test finds a coverage gap. |
| MODIFY runtime `fleet/life-runtime-installation.ts`, `fleet/manager.ts`, `fleet/life-routes.ts`; NEW `test/life-storage-isolation.test.ts` | A corrupt LIFE database currently makes `resume()`/ordinary conversation source throw and can abort Fleet startup. Preserve strict WorldStore rejection, retain the database, and isolate that failed optional store from ordinary chat. Expose a cold owner-only `/api/life/health` status with stable public code, no raw errors/paths/secrets and no provider startup. Never reopen/rewrite a rejected file automatically. Test actual corrupted-file Fleet startup, normal agent operation, cold health GET and unchanged corrupt bytes. |
| NEW `docs/LIFE_ENGINE.md`; MODIFY `docs/VALIDATION.md`, `docs/CODEX_RUNTIME.md`, `docs/PLANNING.md` and platform010–013 where stale | Canonical consumer and operation handoff: exact endpoints/types, management versus viewer capability, request-key/revision semantics, source/knowledge boundaries, image pending/unknown/candidate/application distinctions, recovery and checkpoint commands, explicit configuration and remaining renderer/live-provider evidence. Keep UI and provider owners' existing contracts. |
| MODIFY `docs/plans/life/000_plan.md`,070,080 | Map R01–R11 to actual tests/source/evidence and state the remaining owner/provider dependencies honestly. No invented product defaults or quality score. |

Storage isolation must match the actual owner boundary. All worlds currently share
`state/life/world.sqlite`, whose constructor audits all histories and rejects
corruption (including the original out-of-range event-number case). A rejected
file therefore quarantines LIFE for that installation, not just one row/world;
normal chat/tasks remain available. Per-world runtime/model failures are already
isolated by the scheduler. The earlier sentence promising usable sibling worlds
inside a rejected shared SQLite file is not implementable by swallowing the
startup audit and is corrected here. Do not weaken corruption validation or claim
per-world database quarantine; a different storage partition would be a separate
architecture change. Export/checkpoint preserves the damaged evidence for an
explicit offline restore, without repairing it in place.

Audit refinements before B: match `/api/life/health` before image/publication
routing, behind the existing loopback/Host/no-Origin guard and installation
ownership. Read only recorded `unopened | open | rejected{code}` state; unopened
is not a healthy/audited database. Never evaluate storage/authoring/images from
this getter. Memoize strict-open rejection, and propagate a stable public code
on later management access without attempting another open. A previously bound
agent explicitly degrades to ordinary chat with `conversationSource() ===
undefined`; the health endpoint reports why. Test real bound-agent chat and real
task-manager creation, not just a new unbound agent. Preserve file bytes and the
entire LIFE directory listing after startup, health, chat and a management call.
The failing first-open test exposed SQLite WAL checkpoint/sidecar changes even
when logical recovery rejected the data. Audit a private main/WAL/journal copy
before opening the original; retain the original strict audit on successful open.
The shared `life-runtime-fleet-fixture.ts` finalizes closed native handles during
restart to model a cold process. Keep the existing 070 five-second event gate:
copying and double auditing add startup work proportional to database size.

Capture actor/director/image serialized inputs and assert both private task text
and a planted secret sentinel are absent from forbidden inputs. Checkpoint proof
compares final durable IDs/counters/receipts/hashes after reopening all owners in
a fresh restored root. Document `home/.ima2/server.json`, credentials and external
memory as explicit backup coverage gaps.

The historical runtime rows in the original table below are superseded by the
revalidated table above; only the revalidated table is implemented in080. Renderer
rows remain the UI owner's proposed acceptance specification. The QA-script
strict-typecheck requirement applies only if such scripts are actually created;
this cycle uses the already checked runtime test directory and task-local wire
capture drivers.

Delegation after A: a bounded worker owns `life-checkpoint.test.ts` and its new
child fixture, with no production history changes unless a failing case proves
necessity and main reviews the exact scope. Main owns the integrated causal test,
optional-store failure isolation and consumer documentation. A fresh reviewer
checks the plan and another independent code review checks the final integration.
Native worker/reviewer routing inherits the parent model; no model substitution
or concurrent workflow owner is introduced.

Changed behavior begins red; pure new acceptance tests may start green against an
existing correct generic owner, which is evidence of reuse, not an invented bug.
Use disposable state/ports, signals rather than sleeps, and root types/lint/build,
applicable full regression, dependency/history-secret checks. New test fixtures
live under the already checked runtime test directory. Manual curl checks cover
the new health boundary; earlier07027-case wire evidence is reusable for unchanged
image endpoints, with distinct final source checks. No live call or UI screenshot
is implied by synthetic localhost providers.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-web/client/life-api.ts`, `life-model.ts`, `life-view.ts`, `life-authoring.ts`, `life-profile.ts`, `life.css` | No LIFE client → world creation/editing, timeline/thread, agent profile/history and visible operational states |
| MODIFY client `conversation-app.ts`, `navigation.ts`, `intro-model.ts`, `index.html`, `styles.css`, `agents.ts` | Add ordinary-app LIFE entry and deep links while preserving agent-first navigation, first introduction and draft recovery |
| MODIFY `packages/lina-web/src/life-proxy.ts`, runtime `fleet/life-routes.ts`, `fleet/server.ts` | Complete authenticated draft/run/feed/interaction/asset/profile endpoints; revision and idempotency handling |
| MODIFY runtime `life/config.ts`, `scheduler.ts`; NEW `life/health.ts` | Configurable lifecycle, bounded queues/usage, recoverable failure status and safe diagnostics |
| MODIFY runtime `checkpoint-barrier.ts`, `checkpoint-cli.ts`; history `src/inventory.ts`, `manifest.ts`, `restore.ts` only if existing generic coverage is insufficient | Existing offline checkpoint gains explicit LIFE/world/image lease coverage and restore validation; reuse history ownership |
| NEW web `test/life-model.test.ts`, `life-navigation.test.ts`; runtime `test/life-e2e.test.ts`; NEW `scripts/qa/life-engine.ts`, `scripts/qa/life-browser.ts` | Integration fixture, browser driver and separately enabled provider acceptance runner |
| MODIFY runtime `test/checkpoint-barrier.test.ts`, `checkpoint-cli.test.ts`; history `test/checkpoint.test.ts` | Include LIFE data/assets, reject an active writer, restore and reopen all owner stores |
| MODIFY `docs/PLANNING.md`, `CODEX_RUNTIME.md`, `VALIDATION.md`, platform 009–013 and `packages/lina-web/DESIGN.md` if new surface rules are needed | Planned capability → exactly evidenced capability, remaining limitations and recovery instructions |

File names target the current vanilla TypeScript client, not an invented React app. UI owner may move composition points; map old/new paths before building instead of editing a stale parallel renderer. Keep existing semantic tokens and Codex visual direction. No new concept art is needed for this plan; scene images are product content delivered by 070, not a visual-style redesign.

New URL state originates in authenticated navigation/actions; serializes world/agent/post IDs and non-sensitive view state; parses known variants on boot/popstate; feeds `life-model.ts`, API requests and rendered views. Never put secrets, task logs or provider credentials in URLs/local storage. Server responses include revision/cursor and permitted fields only. Unknown view kinds route to a safe recoverable error, never ordinary onboarding. Test request schemas and browser deserialization as well as core types.

## Interaction contract

| Surface | User path and state meaning |
| --- | --- |
| Start LIFE | Optional ordinary-app entry → write background → review generated draft/missing decisions → confirm world version → preview a step or configure running. First user introduction remains separate. |
| World settings | Edit confirmed background/constraints with before/after preview; advanced rules under a details panel. Conflicts explain the changed revision. Pause/resume and selected operating policy remain visible. |
| Timeline | Read permitted posts, images and threads; switch world/agent without losing position. Quiet world is an honest empty state, not fake seeded posts. |
| Post/thread | Reply, configured reactions and reshare with audience preview. Pending acknowledgment is distinct from posted; retry keeps the same request ID. No mutation on render or background refresh. |
| Agent profile | Current persona and public growth/relations, published experiences and avatar history. World-author private inspection is a distinct mode. Pin/restore acts on avatar revision without overwriting persona. |
| Image states | Awaiting image, generating, uncertain, failed import and completed are distinct. User can reconcile/cancel/retry where supported; don't claim cancellation refunded usage. |
| Running states | Not configured / paused / running / waiting for model / usage exhausted / needs attention. Each offers one relevant next action. Technical diagnostics live behind details, not inside routine feed cards. |

Web/PWA and Electron share the renderer. LIFE adds a destination without replacing the agent list or turning the sidebar into a session list. Mobile uses existing full-screen navigation; back restores world/post/scroll/draft. Use semantic buttons and keyboard focus, readable labels and image alt text derived from permitted material. Preserve dark/light/system tokens, text zoom, reduced motion and screen reader state announcements. Do not force a user to configure simulation to continue normal conversations/work.

## Runtime operations and persistence

One fleet-owned LIFE service opens isolated world/job roots under configured Lina state, not repository fixtures or another task's live data. Shutdown stops admission, cancels local waits, fences pending commits and records uncertain external operations; it does not claim remote cancellation succeeded. Reopen audits schema/history/checkpoints and reconciles outbox/image/publication receipts before admitting new work. A corrupt shared LIFE database is rejected and isolated from normal chat/tasks; all worlds in that database require recovery. Individual runtime/model failures remain world-scoped. Expose an actionable offline checkpoint/restore path without overwriting evidence.

Provide exports/backups for world definitions, accepted log, social checkpoints, inputs/receipts and referenced assets. Record a consistent snapshot boundary; do not copy live WAL files independently and call it a backup. Restore checks versions, owner binding, hashes and referenced assets. Deleting/resetting a world is an explicit user action, not an automatic test recovery strategy. Quotas must preserve idempotency tombstones and audit references. Disabled/archived worlds stop scheduling and retain readable authorized history.

Reuse `lina-history` and the existing offline `checkpoint-cli.ts`/`checkpoint-barrier.ts` path. LIFE and fleet image writers must participate in its installation/owner leases; absent participation is a failed checkpoint acceptance case. Existing state-root inventory may already cover the files: verify that before changing its manifest. Record any external provider history/shared Codex/remote-memory gaps explicitly. Restoring to a new isolated destination and opening every owner store is the proof, not merely a successful copy. No new parallel backup framework or automatic external export is part of this phase.

Diagnostics record step/intent IDs, durations, selected model/engine/rules versions, usage reserved/reconciled/unknown, queue depth, rejected proposals, dedupe hits, blocked disclosure and public error codes. Never log raw secrets/provider request bodies by default. Operational proof can inspect isolated test payloads. Model/image failure does not take down ordinary work; backpressure and queue caps prevent LIFE from consuming all runtime capacity.

## Acceptance layers

| Layer | Execute and observe | What it does not prove |
| --- | --- | --- |
| Deterministic integration | Temporary real SQLite/files, fixture models and fake image transport; task source→event→growth→post→reaction→next step; crash at each commit/delivery boundary | Actual model decisions, provider behavior or interesting content |
| Codex/model contract | Capture real serialized request and tool list for each actor/director/narrator and next ordinary turn; assert knowledge/purpose separation and persona anchors | Whether an actual model follows the intended character over time |
| Actual model | Explicit configured route and run budget; at least one complete causal story plus unseen contrasts with secrets/goals/failed work. Retain request/result evidence and compare future responses | Statistical guarantees across all models/worlds or absence of every inference |
| Actual image | Generate an event picture and reference-based follow-up where supported; import verified bytes, display correct post, restart; avatar slot/pin/restore. Qualify multi-character identity separately | Identity consistency from a catalog row or successful HTTP status |
| Browser | Drive creation→draft confirmation→run/quiet→feed→reply→profile→image→pause→reload on real web renderer; observe screenshots and state changes, desktop/mobile, keyboard | Engine causality if only static mock cards were shown |
| Recovery/operation | Kill/reopen isolated processes at named boundaries; config changes, quota, unavailable model, corrupt DB, backup/restore and stale workers | Deployment/installed-user data safety without a separate rollout |

New QA scripts are **planned, not currently executable commands**. `life-engine.ts` must default to isolated fixtures/no provider, require explicit live mode plus model/image selection and usage cap for actual calls, emit machine-readable evidence and fail on missing invariants. `life-browser.ts` consumes the isolated server handle/URL and records actions/screenshots. No sleeps to await signals; capture real completion events. Keep evidence out of product source and omit credentials/private content. Record the exact implementation revision and tool/runtime versions beside results.

## Quality and stop criteria

Hard requirements: zero duplicate logical events/growth/post/avatar application in the tested crash matrix; zero unauthorized private text/IDs in captured model/API/image inputs; no loss of accepted history; authored anchors and explicit user changes preserved. Contrasts must demonstrate at least one personality-dependent choice, asymmetric relationship update, work-dependent opportunity, belief correction, intentional permitted secret reveal, and user-reply-dependent future action. A no-op “growth stored” result is a failure.

Narrative review uses withheld scenarios, not the actor's own self-grade. Record reviewer/user judgments with examples for character distinction, continuity, plausible consequences, non-repetition and image relevance/recognizability. Keep story quality separate from transport invariants. Do not set an invented engagement-score target or claim psychological validity of trait axes. Persistent failure of these contrasts means revise actor/rules/memory selection, not merely add more random events or posts.

Engine-owned completion requires the integrated story in000 plus distinct serialized model/image and recovery evidence; the actual-model/image and browser rows remain separate qualification dependencies owned by their stated lanes. If paid runs remain unapproved or the image contract cannot support consistent multi-character scenes, report the exact unverified capability; do not downgrade the original requirement silently. UI/image owners implement their surfaces, LIFE owns contract/integration acceptance. Feature flags cannot substitute for demonstrated activation.

## Validation and handoff rules

Before each implementation phase, check current `AGENTS.md`, `POLICY.md`, base revision and actual owner interfaces. Start changed behavior with failing tests. Once focused checks pass, run the repository-required type/lint/build/regression gates for the actual diff. The root typecheck currently includes `packages/*/src`, `packages/*/test`, `packages/*/scripts`, `scripts/*.ts`, `scripts/ci/**/*.ts`; it does **not** include new `scripts/qa/*.ts`. Add an explicit strict QA typecheck or extend the reviewed config and prove it reads these scripts.

Stage rollout separately: isolated test state → user-configured manual LIFE → explicitly configured recurring simulation/publication/images. No live-state migration, merge, deployment or provider spend follows automatically from a passing fixture. Publish verification limitations with the feature. User controls can bypass their own publication/pause settings intentionally; client controls are convenience, the server/store policy is the final application layer (E7), and a compromised host remains outside that boundary.


## Integrated acceptance evidence — 2026-09-08

The integrated fixture uses one disposable Fleet and real task/store owners:
terminal work receipt → explicit share → a work-dependent event → asymmetric
relationship and scoped experience → permitted pictured post → viewer reply →
later scoped experience. Replay after Fleet restart retains operation IDs and
counters. Captured model/image/feed material excludes planted private task and
secret sentinels; authored identity stays unchanged. Image generation uses a
loopback stand-in, not a paid provider.

The checkpoint fixture creates an image with a real world intent/job UUID,
dispatch/count/terminal receipt and archive binding. It refuses an active owner,
restores to a fresh state root, reopens WorldStore, AgentStore and image manifests,
and checks their binding, usage, receipt and asset hash. A separate child is
SIGKILLed after its durable write; the offline checkpoint restores its WAL-backed
state. The image completion in this fixture is synthetic, not a network call.

Independent final review: PASS, no blockers. Its focused run passed 11 tests and
105 assertions across isolation, checkpoint/CLI/barrier and the unchanged
five-second image-event gate (3.54 seconds). The integrated story passed separately
in 16.4 seconds under its declared 30-second integration budget. Eleven actual
curl cases covered cold/open/rejected health, ownership guards, fixed management
failure and the web-proxy boundary. After rejection, original DB bytes and the
LIFE directory listing were unchanged; zero provider calls occurred. All four
listeners closed and the disposable state root was removed.

Startup copy validation reads retained DB/WAL/journal into memory before running
the normal recovery audit twice. Large histories therefore increase startup cost.
Health deliberately returns a stable public failure code rather than a diagnostic
cause. Renderer flows, real model narrative quality, image likeness and installed
user-state migration remain separately unverified; the consumer guide records
those owner boundaries and offline recovery coverage gaps.

Final source run: `LINA_LIFE_NATIVE_TEST=1 LINA_AUTHOR_NATIVE_TEST=1 bun test`
passed 3,363 tests / 17,847 assertions across 480 files in 363 seconds. Source
hashes were unchanged before and after the run; type, lint, build, CI validation
and dependency audit receipts match the same source. Hosted CI is a separate PR
result and is not inferred from this local gate.
