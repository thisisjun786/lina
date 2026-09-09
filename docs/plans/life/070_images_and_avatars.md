# 070 — Event images and evolving profile pictures

Status: completed locally at `e8fb289`, 2026-09-08; source-bound Check passed and the070 cycle closed to IDLE. Follows completed060 `e8078fd` and audited image contracts `d83f317`. Depends on [060](060_publication.md) and the image-owner implementation. Reuse the existing image engine; do not write a second ima2 client or provider router. The concrete extension is [071](071_image_execution_contract.md); [072](072_image_authority_and_accounting.md) resolves the first independent audit's restore, scheduling, serving and reservation gaps. Both refine this same070 work phase.

The user should see an appropriate permitted scene picture alongside a LIFE post,
and may configure profile-picture candidates, automatic application, pinning and
restoration. An image arriving late must keep its original scene and identity;
changing a picture must preserve the agent's personality and learned state.

## Unit contract

| Field | Scope |
| --- | --- |
| Loop / trigger | Satisfy-spec, next dependency-ordered cycle in the user-authorized unattended roadmap. C4 for provider disclosure, persistence/migration and avatar application. |
| Previous D | “Execute070 image/avatar-owner integration using the existing053976d image engine, frozen permitted material, distinct generation/artifact/post/avatar receipts and explicit visual identity/history/pin/CAS contracts. Then080 integrated acceptance and consumer handoff.” This P follows that direction. |
| Goal | Frozen permitted event images and scheduled/event-triggered avatar candidates, durable recovery and audience-safe delivery through the existing image owner. |
| Non-goals | New provider/image engine, UI redesign, multi-reference provider extension, live generation/model-quality certification, invented background/audience/cadence/budget defaults, installed-user-data changes, PR merge or deployment. The resumed scope allows updating PR #3. Reuse the image owner's existing conversation renderer without redesign. |
| Verification | Original fake-provider image/attachment/conversation tests plus new actual DB/manifest/file/Fleet reopen, real HTTP against a loopback synthetic ima2 service, exact final POST guard, image budgets, avatar-state preservation and source gates.071 names activation scenarios and actual paths. |
| Stop / outcomes | Complete070 only after each row below and071 has proof plus independent reviews; continue080. Missing configuration is explicit not-configured. Unsupported multiple identity references are surfaced, never silently truncated. No claim of human-reviewed real likeness. |
| Records / bounds | This document,071 and `images-*` artifacts in the bound session evidence/ledger. Task-owned temporary DBs, ports, files and fake providers only. No user token/time budget was given; no paid provider calls are authorized. |
| Delegation | After A fixes the shared contracts, bounded workers may own AgentStore visual migration/CAS, generalized image jobs/manifest migration, and the final client POST hook in disjoint files. Main owns WorldStore image intent/budget/material and runtime/Fleet composition. HTTP/asset and consumer tests may be delegated after concrete ports exist. Main inspects diffs/proof and reclaims a slice after two distinct failed implementations. |
| Direction changes | Main resolves routine implementation choices against actual owners. Material dependency/permission changes require a plan amendment; external spend/publication still requires separate user authorization. |

## Observed integration baseline

The image-owner source at `053976d6fed2dce32be603b145a6c97e4e52de6f` supplies `images/client.ts`, `store.ts`, `jobs.ts`, tools and session integration. Both it and the clean060 world branch were inspected in this P; the image modules are not yet present on the world branch. Its `ImageJobStore` is a strict v1 JSON manifest under a session binding. `(requestId, callId)` deduplicates a job; its separate UUID identifies upstream generation and attachment. `deliveredEntryId` records a conversation completion, not an SNS post.

States are `prepared`, `submitting`, `queued`, `running`, `post_processing`, `uncertain`, `cancelling`, `completed`, `failed`, `cancelled`. Recovery reads the same upstream ID; uncertain work is not resubmitted. The inspected client contract pins ima2 3.14.0 and accepts at most one reference image. The adapter enforces PNG/JPEG and existing attachment limits. Recheck the integrated revision and capabilities before implementing this phase; do not silently assume multi-reference support.

`WorldImageBrief` v1 currently has event/non-null scene/appearance references but no runtime consumer. `snapshotAt()` returns a trusted full snapshot, not publication-safe data. `AgentProfile.avatarId` uses a hash-addressed avatar store, while generated attachment IDs are UUIDs. Their identifiers must never be interchanged.

Source inventory is `images-p-owner-inventory.md` in the bound evidence directory.
It found no image-spend ledger, pre-send source hook or LIFE owner in the image
slice. The current avatar route calls `AgentStore.update`, which clears persona
candidates and applies a learned-state edit.071 replaces that call with an
avatar-only transaction. Existing world image/avatar config fields remain the
owners of mode/count/interval limits; additional settings must not duplicate them.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| MODIFY `packages/lina-core/src/world/contracts.ts`, `views.ts`, `validation.ts` | Event-only declaration → versioned `LifeImageIntent` for event images and avatar slots using frozen permitted material |
| NEW `packages/lina-core/src/agents/visual.ts`; MODIFY `agents/types.ts`, `validation.ts`, `store.ts`, `index.ts` | Appearance text/current avatar → versioned allowed visual references, identity anchors, avatar history/pin/application receipts |
| NEW `packages/lina-runtime/src/images/contracts.ts`, `life.ts`; MODIFY `images/jobs.ts`, `store.ts`, `session-app.ts` | Conversation-only binding/notice → explicit conversation or LIFE ownership, artifact/completion ports, manifest migration; preserve old conversation flow |
| MODIFY runtime `life/publication.ts`, `scheduler.ts`, `fleet/codex-fleet.ts` | Image candidates → admitted generation work, durable result association and independently controlled post/avatar application |
| NEW runtime `fleet/avatar-assets.ts`; MODIFY `fleet/server.ts` | Reuse verified byte import for manual/generated avatar; dedicated avatar-only CAS transaction rather than generic persona edit |
| MODIFY runtime `fleet/life-routes.ts`; web `src/life-proxy.ts` | Viewer-authorized LIFE asset route; never reuse a private session attachment URL in feed |
| NEW core `test/life-image-contract.test.ts`, `avatar-history.test.ts`; runtime `test/life-images.test.ts`, `life-avatar.test.ts`; MODIFY existing `test/image-jobs.test.ts`, `image-app.test.ts` on integrated image source | All identity, restart, publication and backward-compatibility cases below |

Input chain: accepted publication intent or configured avatar slot → validated frozen `LifeImageIntent` + visual-reference bytes/hash/owner/profile revision → v2 image job manifest owner and origin fields → strict restored owner/result parser → LIFE completion port → post receipt or avatar application receipt. Update every input schema, key comparison, serializer, parser, status consumer, tool result, HTTP projection and test fixture. Existing terminal-state semantics remain; delivery state is separate from generation state. Unknown owner/source variants reject.

## Contract diff

```ts
type ImageOwner =
  | { kind: "conversation"; binding: BotBinding }
  | { kind: "life"; worldId: string; agentId: string };
type LifeImageSource =
  | { kind: "event"; eventId: string; worldRevision: number; publicationId: string }
  | { kind: "avatar"; slotId: string; avatarPolicyRevision: number };
interface LifeImageIntent {
  version: 2;
  intentId: string;
  owner: ImageOwner;
  source: LifeImageSource;
  materialId: string;
  policyRevision: number;
  visualReferences: VisualAssetRef[];
  briefDigest: string;
}
// ImageJobs(owner, artifactPort, completionPort) preserves the existing client.
// Generation, imported artifact, published post and applied avatar each have receipts.
```

`VisualAssetRef` distinguishes avatar/attachment/approved identity reference with owner scope, ID, SHA-256, media type and profile/visual revision. Freeze references and permitted scene at intent creation, before dispatch; retries never read today's appearance or location to reconstruct yesterday's picture. Reference bytes need permission for the actual provider/publication purpose. Private images, EXIF or prompts do not become eligible merely because an agent can read them.

Candidate selection records why an image helps (visible scene change, meaningful encounter, authored milestone, explicit request) and why it was skipped. Text-only events are normal. Avoid near-identical pictures using accepted content/scene/reference fingerprints and configured cooldowns; do not invent “one image per N posts.” Image generation must not gate the accepted world transaction. Feed can publish text with a separately pending image attachment when the configured publication policy allows it; a late receipt updates that post once, never creates a duplicate post. Failure leaves an honest text result and retry/reconcile state.

Single-reference capability is a real limitation: select an explicitly approved canonical reference for a one-character image, or hold multi-character identity-sensitive work as unsupported. Do not silently discard other participants' references or claim consistent multi-agent depiction. Adding multi-reference input requires image-owner changes to `client-types.ts`, `client-contract.ts`, `client.ts` and an actual upstream contract test; it is an explicit dependency for full multi-character image acceptance. A reviewed composition approach is an alternative only when its extra operations/cost and identity quality are proven.

Generalize the existing job state machine through ports. Conversation jobs keep session lifetime, attachment ownership and notice delivery. LIFE jobs have a fleet-owned lease and a world-scoped storage root; one world's uncertain image must not block all conversations/worlds. Migrate valid v1 manifests preserving every ID/state/result; crash during migration leaves the original readable. Never reinterpret conversation job keys as LIFE keys. Asset quotas and retention are configurable; current 256-job/attachment caps cannot silently truncate long-running LIFE. Archive terminal metadata with retained dedupe tombstones and stop admission before storage exhaustion.

Avatar material is built from the agent's approved visual identity and selected avatar policy, without inventing a source world event. Both source variants require a validated material record; an avatar slot cannot use the non-null scene constraint of `WorldImageBrief` v1. Restrict `LifeImageIntent.owner` to the LIFE branch when parsing this contract; the general `ImageOwner` union is for the reusable image job service.

Avatar scheduling creates a stable `(agent, world, effective cadence, slot)` intent; event-triggered identity uses the actual event instead. Full policy/config revisions remain provenance, not generation-key inputs, as072 defines. Optional event-triggered and periodic slots use the chosen world/real-clock policy, not wall time guessed from events. Avatar pin prevents automatic replacement; generation may be skipped or retained as a candidate according to explicit settings. Keep history and allow restore without regenerating. Add an operation-keyed `applyAvatarOnce` with avatar history/pin/application receipt in the same AgentStore transaction, using072's separate automatic and manual/restore guards. User appearance/avatar edits advance visual revision; stale results remain history candidates. Do not use generic `AgentStore.update()` unchanged: it also clears persona candidates and couples unrelated edits. Avatar-only updates must not alter personality/evolution/reflection state.

Add recognized AgentStore-owned visual/history/application and capacity tables as specified in071/072. Candidates are unique by agent/intent/attempt; application operations are unique by agent/requestKey and exact payload, so repeated historical restoration remains possible. Its current column and foreign-table checks must explicitly recognize the migrated shape. Migration preserves profiles, learned dynamics, pending persona candidates and old avatar references; unknown/partial schemas reject. Store visual revision/pin policy/reference provenance alongside history, then decode them in `visual.ts` before avatar scheduling, API preview or application. A file import can precede the transaction, but it is not an applied avatar until the transactional receipt exists; unreferenced imports can be reclaimed without losing completed receipts.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| Accepted event then crash before image dispatch | One frozen intent, same scene/profile revision and brief hash on recovery |
| Provider accepted request but response lost; endpoint/version changed; history expired | Read only original generation ID; no replacement POST; explicit uncertain/attention state |
| Download succeeds then crash around import; same ID with different bytes | One verified artifact or explicit hash conflict; no false completed image |
| Post commits then completion response lost; image arrives after text | One post and receipt, asset attached once; retry cannot publish a second caption/post |
| Permission changes before submit or publication; private reference/alt text present | Withhold forbidden work; captured provider/feed inputs exclude private material; revoke application asset access |
| Multi-character references on inspected single-reference client | Explicit unsupported state, not silent first-reference truncation or claimed identity preservation |
| Avatar tick duplicated; pin/user edit/newer slot races old result | One candidate/application; latest user choice preserved; persona candidates unaffected |
| Cancel races generation completion; disk/quota full; configured budget exhausted | Actual generation fact retained; publication separately withheld; no new provider call on capacity/usage rejection |
| Load legacy conversation manifest and run existing generate/edit/delivery fixtures | Same original binding, IDs, notice delivery and recovery behavior |

These are future tests on the integrated tree. Existing image tests prove their own fake-transport contracts; committed image QA notes are prior evidence, not a fresh LIFE provider/browser run. 080 requires actual event→permitted brief→provider→artifact→feed and avatar tests with a chosen budget. Provider output is not guaranteed to preserve likeness; human image review is required. Final application controls are validated job/asset/publication APIs (E7); previously exported provider/viewer bytes cannot be recalled. Update image plan 009, daily-life plan 010 and validation scope with exact evidence.

## Checkpoint, 2026-09-08

The user requested a reviewable PR checkpoint before continuing.070 remains in B;
080 has not started. The existing world-engine PR includes the completed010–060
work and this partial070 implementation. It must remain Draft until the remaining
implementation, checks and independent reviews are complete. No merge, deployment,
installed-user-state update or live provider spend is included.

Implemented in this checkpoint:

- Schema8 image settings, frozen intents, attempts, accounting and original-source
  recovery audits; AgentStore visual identity/grants, candidate history, pinning,
  avatar-only application and restoration receipts.
- Existing image-owner client/jobs/renderer integration, manifest2 migration,
  lifetime manifest leases, final outbound permission and capacity checks, owned
  artifacts, original-UUID recovery and explicit retry after a known failure.
- Fleet scheduling, owner management routes and fixed web proxy; current scoped
  post-image metadata/bytes, late attachment cursor invalidation, automatic
  portraits and next-period recovery without duplicate generation.
- Avatar upload metadata-before-bytes, request-key repair, verified seed/legacy
  migration and generated-byte serving authority. Independent avatar rereview
  passed after all reported repairs (9 tests,37 assertions).
- Terminal archive bridge with preflight capacity and interrupted-file/reopened-DB
  adoption (63 affected tests). Scheduler archive invocation is still pending.
- Paused scheduled recovery no longer applies a completed avatar. The actual
  composition regression first reproduced the incorrect application, then passed
  both manual and automatic-origin cases (2 tests,28 assertions). Resuming applies
  the original result without another provider POST.
- Transaction-local immutable source memoization removes repeated historical
  resolution for attempts sharing a source. Current permission checks are not
  cached, and later revocation/corrupt reopen remain covered.

Verification at source commit `aab0c9c`:

| Command | Result |
| --- | --- |
| `LINA_LIFE_NATIVE_TEST=1 LINA_AUTHOR_NATIVE_TEST=1 bun test` | 3,316 pass,1 fail;17,501 assertions across471 files,424.20s. Exit1. |
| `bun run typecheck` | Pass; root and browser TypeScript. |
| `bun run lint` | Pass;20 warnings and informational diagnostics remain. |
| `bun run ci:build` | Pass; runtime web assets and read-only CLI smoke. |
| `bun run ci:validate` | Pass; CI workflow/forms/contribution links. |
| `bun scripts/ci/audit.ts` | Pass; lockfile and30 installed package names, including bundled copies. |
| `bash scripts/ci/secrets.sh` | Pass; full Git history through the source checkpoint, no leaks. |
| `git diff --check` and LIFE plan links | Pass;46 local links resolve. |

The sole failing case is the event-image integration timeout below; the full run
reproduced it in8.67s before finishing all downstream test files. Source/config/test
hashes remained unchanged across the checks. No skip or timeout relaxation was
added. This is a failed overall test gate and an incomplete070 review, despite the
other passing checks.

The earlier266-test incremental run and060's2,885-test result are separate
revisions. All new runtime calls use temporary state and synthetic local
transports. Real model/image quality and browser presentation are not qualified.

### Remaining work before070 completion

- Integrate current `dev` image-owner changes before merge. A read-only merge
  preview found13 conflicting files in attachments, Fleet, the image client/jobs/
  store/tools and their tests. No merge/rebase or conflict-marker edits were made
  during this checkpoint. GitHub reports the PR as conflicting; no current-head
  Actions run or check run was observed.
- Repair the event-image integration performance failure: the default5-second
  test times out (the focused current run took9.19s). A14.32-second diagnostic run
  with an explicit60-second timeout reached all14 assertions; it is not a passing
  default-timeout gate. The diagnostic timeout and prints have been removed.
- Recheck scheduled admission with an explicit pause and legacy avatar-only
  worlds with `run: null`; the final runtime review did not qualify these paths.
  Verify manual event-image requests without an automatic event rule.
- Wire terminal archive movement into the shared scheduler and complete retained
  work recovery when current generation settings are disabled.
- Verify unused destination reservation release/reacquisition, capacity changes,
  orphan bytes, current authority and delivery recovery across both stores.
- Complete event-family/scene/cooldown discovery and multi-character reference
  coverage. The image owner currently supports one reference; unsupported multiple
  identity references must remain explicit.
- Finish the full070 independent review and isolated HTTP acceptance matrix,
  then close070 before starting080. Keep all071/072 acceptance criteria in force.

Local raw logs and reviews remain under the task's ignored evidence directory;
public reports include only commands, outcomes and synthetic scenario descriptions.

### Resumed implementation, 2026-09-08

The user explicitly resumed work after the PR checkpoint. Continue070 and080,
then update the existing PR; merge, deployment and real provider spend remain
outside this authorization. The checkpoint above remains a record of `0b68b2f`,
not the verification result for the changing working tree.

- The original event-image test reproduced its default5s timeout at8.25s.
  Repeated structural decoding and pure replay calculation dominated the measured
  work. Bounded reuse now compares complete stored rows and their dependencies,
  and still checks current source/permission authority. Independent review found
  the first4.79s result lacked margin (repeat runs4.86–5.14s). Historical snapshots
  now also reuse unchanged read transactions, comparing SQLite `data_version`
  and `total_changes()` after establishing the read snapshot. Writers clear on
  entry and commit/rollback; external commits invalidate the next read. The
  original unmodified test then passed all14 assertions in3.20s. No timeout/skip
  change was made; final suite and independent rereview remain required.
- New warm-read negatives cover caller mutation, another connection changing
  step/paired-commit/pack bytes while retaining their digest, deleted autonomy
  baseline and rolled-back writes. A same-transaction corruption test also proves
  local-write invalidation: disabling the epoch comparison makes it fail.
  Six tests/13 assertions pass with the guard restored. The affected
  autonomy/social/image core run passed280 tests/1,079 assertions in57 files.
- The actual Fleet legacy portrait scenario first failed because image settings
  required prepared LIFE state. Legacy wall portraits now use the existing world
  roster and require no authored pack, autonomous run, director or publication
  settings. The run-null exception is limited to wall portraits; explicit pause
  still denies provider dispatch and automatic application. Original and legacy
  generation/application/serving/restart/next-slot tests plus related image cases
  passed120 tests/494 assertions in24 files.
- Independent replay rereview passed: three original-timeout runs took3.13–3.22s
  with14 assertions, and the full core suite passed1,295 tests. The same event
  scenario now uses an actual ephemeral loopback HTTP image service, the real
  client and Fleet/web proxy, including bytes after restart and permission revoke;
  it passed in3.19s. This is synthetic-provider transport proof, not image quality.
- Current `dev` image-owner code is integrated in local merge `3dc2721`.
  All13 conflicts resolved against the already-integrated053976d source pin.
  An automatically duplicated session return field was removed and the upstream
  image-tool startup test retained. Forty owner/session/scheduler tests passed.
- Scheduler archive/recovery is wired through mandatory existing owner ports;
  original and legacy Fleet cases verify the original attempt is archived after
  restart with no extra generation. Manual event image requests now select the
  exact permitted post/author/recipient without requiring automatic rules.
- Automatic discovery covers family receipts, no-rule/empty-material outcomes,
  duplicates, cooldown boundaries, scene fingerprints and multiple subjects.
  Shared-event posts by another authorized participant now inherit the accepted
  event family; poster-specific image rules remain required. Independent review
  passed that correction against the publication contract.
- Unused destination reservations release on revoked grants, pinned-skip policy,
  stale application CAS and pause/foreground withholding before copy. The original
  world artifact and consumed generation count remain. Explicit reacquisition uses
  the original generated reservation and current shared capacity, without changing
  ordinary released-reservation replay. Real-store tests cover competing uploads,
  exact history limits, settled replay, reopened stores and applying the same image
  after permission restoration. The actual Fleet pause-after-result case keeps
  zero copied candidates, then applies the original result after resume.
- Final runtime review, whole-source verification and080 remain open. No remote
  update, PR merge, deployment or live provider spend is claimed by this record.

Additional integration review and wire QA found two remaining boundaries:

- Manual destination application now binds `candidateId` to the original image
  attempt before copying bytes or registering history. The new negative case
  first observed an unwanted history row, then passed with no row/file write.
- Image-management and visual JSON mutations reject absent/non-JSON media types
  before parsing or writing. Actual `curl` originally returned201 for a
  `text/plain` event request and200 for a `text/plain` pin; regression tests and
  matching adjacent API boundary checks now reject them. Binary reference upload
  retains its separate byte protocol.
- The intermediate24-case HTTP run exercised explicit event generation without
  automatic event rules, duplicate request/run replay, attachment, fixed-proxy
  asset access, same-state Fleet reopen and visual-grant revocation. Exactly one
  synthetic image POST occurred; the retained text post survived image withdrawal.
  All temporary listeners and state roots were removed. This is wire/recovery
  evidence, not actual-provider or renderer proof.
- Independent review found that paused admission could leave a never-reserved
  prepared attempt blocking future avatar slots after resume. This is a blocker;
  a dedicated recovery regression and fix are required before070 closes.

Full-suite runs made while new negative tests were being added are retained as
intermediate evidence, not passing final gates:3347pass/3fail and3350pass/1fail.
Fresh focused destination/composition tests passed6cases/94assertions after the
candidate fix. Final review and unchanged-source verification remain required.

The pause blocker is now repaired in the working tree. Paused discovery emits no
new candidate or due-time loop; a new manual run checks current authority before
creating an attempt. A retained prepared attempt without any world reservation
cannot have reached dispatch, so an obsolete one no longer blocks later slots.
Its original record remains intact. Reserved/uncertain work keeps its existing
recovery path. Manual avatar selection also consumes the same automatic slot or
event, preventing a duplicate automatic generation after resume.

Actual Fleet regressions cover automatic pause, denied manual admission, retained
unreserved work, and two later successful slots. All60 runtime image tests passed
(378 assertions). The final-source wire run passed27 curl cases, including visual
media-type rejection, with exactly one synthetic image POST across restart and
revocation; all four Fleet/web listeners and the temporary root were removed.
Types, lint, build, dependency audit and CI metadata checks passed against
unchanged source hashes. Full-suite output and independent rereview are still
pending; these results alone do not close070.

## Final local verification, 2026-09-08

The implementation and independent runtime rereview passed. The final root run
reported3,357pass/0fail,17,732assertions across477files with the native LIFE and
world-author contract lanes enabled. Production files did not change during the
run. Its only source-snapshot difference was a test-local variable rename for
lint; the reviewer confirmed no behavior change and the final5-case/36-assertion
pause suite passed again. Source-bound Check validates both artifacts rather
than presenting the first snapshot as identical.

Reserved prepared work now reconciles to a local cancellation only when both
owners prove no provider dispatch and current authority is gone. It settles
`no_post`, releases the unused avatar hold and permits later slots. A durable
dispatch marker instead preserves unknown usage and the reservation. A paused
retry is rejected before a new head attempt is created. These cases, including
the actual catalog/foreground race, are in `life-image-pause-recovery.test.ts`.
The final affected image suite passed62tests/397assertions.

Final HTTP qualification passed27curl scenarios on the final production source,
using one synthetic image POST across repeated run, attachment, same-state Fleet
reopen and grant revocation. Teardown verified every owned listener closed and
all temporary state removed. Type/lint/build/CI metadata/dependency checks passed;
Check binds the final commit and history secret scan before cycle closure.
Independent replay/capacity/legacy reviews and the final runtime rereview report
PASS. Existing unknown provider outcomes remain held rather than resubmitted.

This qualifies the engine's local integration and recovery contracts. Actual
model/image quality, multi-character likeness, the LIFE renderer, hosted CI and
installation rollout remain separate evidence layers. Continue080 integrated
acceptance and the UI/image-owner handoff; do not merge or deploy from this result.
