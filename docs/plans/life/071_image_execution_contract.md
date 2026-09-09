# 071 — LIFE image execution and visual identity

Status: P contract for070 at `e8078fd`, to be independently audited before code
changes. [070](070_images_and_avatars.md) owns the objective, resource/permission
bounds and acceptance criteria. This document makes its existing implementation
proposal concrete against the completed publication source and image-owner
`053976d6fed2dce32be603b145a6c97e4e52de6f`.

[072](072_image_authority_and_accounting.md) is the accepted main-agent synthesis
of the first independent A FAIL. Its precise restore/scheduling/serving/accounting
contracts supersede less-specific wording here; independent re-review is required.

## Existing owners and reuse

Import the image owner's `images/{client-types,client-contract,client-http,client,
store,jobs,tools}.ts`, its `image*.test.ts`/`ima2*.test.ts` and fixture files.
Apply its stable-ID `AttachmentStore.put(name, bytes, id)` delta with attachment
tests, session constructor/resume/notice/shutdown wiring and Fleet ima2 options.
Keep this branch's `host.ts` and `sdk-port.ts`: their later source-provenance
contracts remain authoritative. No dependency or lockfile change is needed.

Reuse the owner's four existing Markdown renderer files and their tests as an
unchanged consumer dependency, preserving attachment-scope checks. This is not a
new LIFE UI. UI ownership and the full feed/profile consumer remain080's handoff.
Resolve integration hunks locally; do not merge/push either owner's branch or
replace its worktree. Record copied source provenance and inspect the final diff.

Relevant current anchors:

- AgentStore construction/audit: `agents/store.ts:78`, `agent-schema.ts:46`.
  Schema1 contains learning tables. Unknown/partial schemas reject.
- Generic profile update: `agents/store.ts:157`; the avatar upload currently
  invokes it at `fleet/server.ts:316`, clearing persona candidates.
- Existing image limits/config: `world/authoring-types.ts:224`; image/avatars
  fields exist, but `maxImages` has no execution ledger yet.
- Frozen public sources: `world/publication-types.ts:46`, `store.ts:1170`.
  `PublicLifePostView` decoration is separate from immutable reply content.
- World schema7: `world/schema.ts:11`; migration validates each previous owner.
- Runner/scheduler: `life/runner.ts:90`, `life/scheduler.ts:312`; one background
  admission owner, current invocation authority and finite wakes.

## Manifest, input and delivery contracts

Use one `ImageJobs` implementation with partitioned instances. Its store owner is
`conversation(binding)` or `life(worldId, agentId)`; LIFE roots live under the
fleet's `life/images/<worldId>/<agentId>/`. Retain conversation roots exactly.
An uncertain job blocks only its owning instance, not every world/conversation.

Canonical `ImageOwner` and LIFE intent/source types live in core
`world/image-types.ts`; `LifeImageIntent.owner` accepts only its LIFE arm.
Canonical visual/reference/candidate DTOs live in core `agents/visual.ts` and do
not import world persistence or runtime. Runtime `images/contracts.ts` imports
those types and owns the executable ports. World image code may depend on pure
visual types; AgentStore receives a minimal candidate/asset receipt rather than
a WorldStore or whole runtime job. This preserves runtime→core direction and
avoids two type owners or a world/agent persistence cycle.

New `images/contracts.ts` defines strict discriminated input/origin and delivery
contracts. Conversation input retains the original requestId/callId semantics.
LIFE input carries real intentId/attemptId/briefDigest and frozen reference
identity; never manufacture a conversation request or call ID. The job UUID
remains the upstream and artifact ID. A repeated owner/origin key with changed
provider/model/prompt/reference bytes or hash conflicts.

Generalize the concrete artifact operations used by `jobs.ts` into an injected
port: resolve the frozen reference; preflight capacity; import output with the
job UUID; and verify retained bytes/metadata. Generalize notice delivery into a
completion port returning either a conversation entry receipt, a LIFE delivery
receipt, or pending. `images/conversation.ts` adapts the existing AttachmentStore
and native `appendNotice`; `images/life.ts` adapts the world-owned image records.
Conversation `deliveredEntryId` is retained and never used for a LIFE post/avatar.
The strict new delivery discriminator separates the two receipt owners.

The v2 manifest retains every v1 record field and value, with explicit
conversation ownership/origin/delivery. Validate the original v1 shape first,
including records, binding, duplicate IDs/keys and byte limits. Preserve an
immutable original snapshot, then fsync/atomically replace the canonical file
under the existing lifetime owner. An invalid v2 canonical manifest cannot fall
back to stale v1. On restart, partial/corrupt/foreign ownership rejects before
any client request. Byte/history tests cover every old terminal and uncertain
state, timestamps, result filenames, cancellation and delivery fields.

Do not change the original recovery rule: interrupted prepared conversation
jobs are known not submitted; submitting/uncertain jobs read only their original
UUID at their original endpoint/version. A LIFE retry needs an explicit new
attempt only after a known prior outcome. A missing/expired upstream record does
not authorize POST. Do not treat an import failure with retained resultFilename
as proof that generation never happened; it may be reconciled/downloaded again
without a new generation. Completed generation, imported artifact, post binding
and avatar application remain separately recorded facts.

For LIFE only, a provably never-submitted prepared record can remain prepared
and be re-admitted with its original UUID under current authority. Paused/manual
scheduler recovery does not start it. The legacy conversation recovery behavior
is unchanged. Add a narrow explicit artifact-recovery operation for a failed job
with an already saved, validated resultFilename: read/download that same result,
verify/import under the same UUID, then transition to completed through the store's
dedicated guarded operation. Generic terminal updates stay forbidden. A failed
job without that provenance cannot invent a result or resubmit as artifact recovery.
This new artifact-recovery operation is LIFE-only. Conversation terminal notice
identity and delivered failure behavior remain unchanged. The original failed/
import and later recovered LIFE receipts remain distinguishable.

LIFE job creation must be durable before dispatch and linked to its world attempt
before POST. Add a prepare-without-submit path using the same store and start
machinery: core attempt → manifest create/dedupe → core UUID link → start.
Recovery adopts that same owner/origin record before starting/reconciling it.
No eager LIFE resume runs before this linkage. Conversation start behavior stays
compatible. Archive only terminal acknowledged metadata into verified immutable
records with retained dedupe entries. An archive is not permission to generate
again. Missing/conflicting archives reject. Storage exhaustion stops admission;
it never deletes historical identity to make room.

## Frozen material, references and independent image accounting

Add world-owned `image-types.ts`, `image-validation.ts`, `image-material.ts`,
`image-persistence.ts` and `image-schema.ts`; thin WorldStore methods compose
them. Schema8 adds image settings/history, intent/attempt/history, admission and
delivery records plus asset associations. Audit schema7 before migration inside
the existing transaction. No settings, intent, visual permission or generation
is invented by migration. Extend schedule-history audit if an image invocation
records a world lease; a real image owner must never impersonate a LIFE step.

`LifeImageIntent` is LIFE-only and immutable. Its discriminated source is an
actual generated event post (post ID/revision, original event/world/LIFE revision,
material ID/digest) or an avatar slot (agent/world/effective clock-slot identity,
with full policy revision retained separately as provenance).
Its frozen material contains the permitted scene/claims or approved avatar
identity, public prompt/alt text, subject list, approved reference hashes/owners,
visual revision and policy provenance. Retain `WorldImageBrief` v1 compatibility;
an avatar has no fabricated event or mandatory world scene.

Build event material through a new trusted WorldStore accessor for the stored
published material and current complete post authority. Never use `snapshotAt`
as public material. Only rendered supported claims and separately permitted scene
data may enter the image brief. Imaginative/user words remain labelled; neither
becomes a factual scene claim. Generated replies without a permitted scene are
text-only unless a later explicit scene contract authorizes them. A current
TaskManager check supplements world work evidence at each effect/read boundary.

Use explicit world image settings for provider/model, selection rules, visual
purpose, content/scene cooldown, asset/job byte/count capacity and delivery
policy. Reuse LifeConfig.images, avatars and usage for mode/per-step/per-window
limits and wall-clock interval; do not introduce another copy of those fields.
Settings are absent until all required choices are supplied. Technical MIME and
2 MiB limits are distinct from user budgets. Monetary cost remains unknown unless
the owner supplies verifiable cost evidence; an image count is not a money cap.

The new settings input is an exact object, with all fields required:

```ts
type LifeImageSettingsInput = {
  version: 1;
  worldVersion: number | null;
  route: { provider: string; model: string };
  eventRules: {
    familyId: string;
    agentIds: string[];
    trigger: "event" | "scene_change";
    composition: "single_subject" | "all_scene_subjects";
  }[];
  avatarEventRules: { familyId: string; agentIds: string[] }[];
  perAuthorCooldownSteps: number;
  attachMode: "manual" | "automatic";
  maxJobsPerVisit: number;
  storage: {
    maxActiveJobs: number;
    maxArchivedJobs: number;
    maxAssets: number;
    maxTotalBytes: number;
  };
};
```

Persist worldId/revision and immutable history outside this input. `worldVersion`
names the exact active authored-pack version on save and the immutable pack for
history audits. It is null only for a legacy world with no authored pack and
empty eventRules/avatarEventRules arrays; explicit permitted-post requests still work there.
Validate rule families and agents against that actual authored-pack history as
publication settings do; current retirement/removal fences new images. Zero limits disable their
respective behavior. The existing `images.maxPerStep` and `usage.maxImages`
remain additional limits, not copied here. Avatar generation uses the same world
route/storage budget with its AgentStore policy below. A manual event request can
select a currently permitted post without an automatic event rule.

Selection operates only on permitted material. Record selected/skipped reasons
for explicit request, configured visible scene/encounter/milestone rules,
unchanged content, missing permission, unsupported references and capacity.
Fingerprint semantic scene/content and approved visual references, excluding
incidental IDs/time; combine this with configured cooldown and per-step limits.
No default “one image every N posts,” invisible-state signal or extra selector
model is introduced. Discovery/drain may create records; reads may not.

The original adapter accepts zero or one reference. An explicitly approved
single subject can use its canonical reference. Multi-subject identity-sensitive
work requiring multiple references becomes unsupported before submission; do
not silently keep only the first. Text-only generation requires an explicit
approved identity policy, and does not claim measured likeness.

Reference approval applies to exact validated PNG/JPEG bytes/hash and separately
to provider use and the destination purpose: an explicit world/recipient or
public avatar. Merely finding an attachment or current avatar grants neither.
The approval contract covers the actual byte payload including metadata; no
automatic EXIF sanitization is claimed. Reject unapproved/changed references,
cross-session paths and unsafe files. Do not forward original filenames, private
profile biography, raw task/experience text or unrestricted world summaries.

Reserve one image and bounded output storage before a new POST in the world
transaction. Event and avatar attempts share LifeConfig.usage.maxImages in its
configured window; avatar maxPerWindow and event maxPerStep add their own bounds.
Prepared/dispatched/uncertain reservations survive restart/window changes.
Only authenticated zero-attempt failure releases an unused image-count reservation. A known
provider attempt consumes the allowance even if generation/import/application
fails; cancellation acknowledgement alone is not a refund. Reconciliation and
download of that same result do not charge another image. Test two contenders
for the last slot with actual stores. Retained uncertainty prevents further image
admission under that world allowance, not unrelated text/conversation budgets.
Storage has independent settlement, reference and installation-wide avatar-copy
accounting, specified in072; count consumption never prevents releasing unused
output capacity after a known terminal failure.

## Visual identity and avatar application

`agents/visual.ts` owns validated visual state and history; a focused persistence
helper may hold SQL. Migrate AgentStore schema1 to2 with `agent_visuals`, immutable
visual history, `agent_avatar_history` and `agent_avatar_receipts`. Validate old
profiles/dynamics/candidates/learning before DDL and new rows before commit.
Preserve every old profile and pending persona candidate. Existing avatar IDs
remain usable but do not become approved provider references automatically.

Visual state has its own revision, owner-approved anchors/references and purpose
permissions, canonical reference selection, pin and explicit avatar policy.
Avatar policy has a distinct policyRevision, changed only by an effective policy
edit. Applying/pinning/restoring a picture must not change the clock-policy key
and thereby generate another image for the same slot. Historical reference grants remain auditable; changing
canonical selection does not itself assert revocation. An explicit revoke fences
future use and restricted application/serving. Appearance/avatar edits advance
visual revision and stale pending automatic results. Ordinary nonvisual profile
edits do not erase the visual history.

The avatar policy explicitly binds one source world per agent, generation/apply
mode and slot policy. Wall-clock slots use the existing configured interval with
an explicit epoch. A world-step variant uses explicit step interval/epoch and
does not interpret arbitrary world ticks as milliseconds. Event-triggered slots
bind a configured permitted event and do not invent a clock. Duplicate ticks or
events derive the same logical slot; newest admitted slot and visual revision
fence late older results. A policy change preserves history without silently
rerolling an unresolved generation.

Use exact discriminators for the additional visual policy. `null` means absent;
there is no auto-selected clock, source world, reference or application mode.

```ts
type AvatarPolicy = {
  worldId: string;
  applyMode: "manual" | "automatic";
  whilePinned: "skip" | "candidate";
  schedule:
    | null
    | { kind: "wall"; epochMs: number }
    | { kind: "steps"; epochRevision: number; intervalSteps: number };
  eventFamilyIds: string[];
};
type VisualPurpose =
  | { kind: "avatar" }
  | { kind: "life"; worldId: string; recipientId: string };
```

The wall variant requires LifeConfig.avatars.intervalMs; the steps variant uses
its explicit step interval and rejects an ambiguous simultaneous wall interval.
Generation/manual/automatic mode and maxPerWindow remain in LifeConfig.avatars.
Visual state stores anchors, canonical reference ID or explicitly approved
text-only identity, exact byte references with providerUse/purpose grants,
pinned flag and AvatarPolicy. Its own history revision supplies the policy/visual
fence; full avatar policy revision remains provenance while effective cadence
fields identify scheduled slots. The latest
admitted intent/order lives in avatar history/admission receipts, not a visual
edit that would immediately stale its own frozen revision. Reference upload/import first registers unapproved bytes; a separate exact
visual-state CAS explicitly grants provider/destination use. It never turns a
private session attachment into an approved reference by presence alone.

One event post has one automatic logical image intent; one agent/world/effective
cadence/slot has one logical periodic avatar intent, and one actual event/agent
has one event-triggered avatar intent. New budget windows or repeated discovery cannot mint
another. Every known-outcome retry has a new attempt under that same intent and
uses the original frozen brief/reference bytes; changed material conflicts.
Settings/appearance changes can withhold obsolete intent material. A new explicit
generation request is a separately identified owner operation; it does not erase
the original receipt or authorize automatic rediscovery. Only one current post
association or avatar application is chosen through destination CAS.

Record the generated asset as a history candidate first. `applyAvatarOnce` checks
its intent/candidate/asset identity and current purpose permission. Automatic
application checks frozen visual/profile revision, latest slot, pin and current
mode; manual apply/restore instead uses current management CAS and may select an
older candidate. Existing operation receipts are checked before freshness, as072
defines. Update only avatarId/profile revision, visual revision, history status and
the dedicated application receipt in one AgentStore transaction. Never invoke
generic `update`, learning.edit or persona-candidate deletion. Replaying the same
receipt returns its original outcome. A stale result remains a candidate.

Manual upload uses the same verified hash-addressed avatar import and avatar-only
transaction, preserving existing HTTP profile revision CAS. Explicit pin/unpin,
candidate apply and history restore use management CAS; restore reuses bytes and
creates an application receipt without generation. Restoring a choice advances
visual state so old automatic work cannot overwrite it. Whether pinned schedules
skip generation or retain candidates is an explicit policy, not an assumed default.

World DB, manifest/files and AgentStore have separate transactions. Replayable
receipts bridge them; no distributed atomicity is claimed. A crash after file
import or avatar commit but before world acknowledgement resumes the original
receipt. UUID attachments and SHA-256 avatar IDs are converted only by verified
byte import, never assigned interchangeably.

## Runtime, final authority and public assets

Extend the existing runner/runtime admission with a bounded image operation,
using the same foreground cancellation and lifecycle. The scheduler visits image
work on existing event/config/recovery wakes and explicit avatar deadlines;
no per-post timer. Saved manual input never authorizes scheduled generation or
application. Paused recovery may record already-observed results without new
POST or automatic publication/avatar changes. Image uncertainty yields control
with no immediate polling loop. Provider status polling stays inside ImageJobs.

Add trusted nonserialized `beforeSubmit` through client-types → client →
client-http. It executes after awaited connection/reference preparation and
immediately before the actual generation POST, checking linked attempt/lease,
current source/visual permission, frozen bytes and budget/storage reservation.
A refusal is known not dispatched. Preserve read/cancel/download recovery after
source withdrawal while independently withholding destination effects. A returned
generation fact is retained even after lease loss or foreground cancellation.

`images/life.ts` and a world-scoped asset adapter supply the shared jobs ports.
Fleet creates/drains these under installation ownership; readers use storage-only
access and must not warm clients/schedulers. Use the same ima2 options as the
existing conversation integration. One world's pending request never prevents
other roots from reading/reconciling their own state.

Post image association has its own receipt/revision. It does not rewrite the
immutable post, parent revision or frozen reply material. Decorate
PublicLifePostView with currently authorized image state/asset metadata and
include it in viewer cursor scope, analogous to reactions. Text may precede the
image; late delivery updates that association once. Failure remains an honest
text result. Never expose an internal job, reference, prompt or provider URL.

Add owner-only image settings/intents/run/retry/reconcile and visual
settings/history/pin/apply/restore routes with exact fields/CAS. Add only the
viewer-authorized `/feed/posts/:postId/assets/:assetId` route to the web proxy;
validate the bearer/post/current source/visual-purpose authority after awaits
and before bytes. Do not reuse private conversation attachment URLs. Serve
verified PNG/JPEG bytes with safe fixed names, nosniff and no-store. Current
revocation hides the asset without destroying its generation/history receipt.
The global `/api/avatars/:hash` route also consults generated-asset lineage and
current permission. Keeping its URL/caller shape is not a permission bypass;
072 defines manual/legacy compatibility and identical-byte multi-owner behavior.

Exact route families, all under the existing loopback/installation boundary:

- `/api/life/worlds/:worldId/images/settings` GET/PUT (expectedRevision/settings),
  `/images/intents` GET/POST (requestKey, source selector and expected settings
  revision), `/images/intents/:intentId` GET, and its `/run`, `/retry`,
  `/reconcile`, `/apply` POST operations (requestKey and expected revision).
  Manual run is trusted owner admission, never a viewer body mode.
- `/api/agents/:agentId/visual` GET/PUT (expectedRevision/exact visual input),
  `/visual/references` POST validated binary upload plus existing profile/visual
  CAS headers, `/visual/history` GET, and `/visual/pin`, `/visual/apply`,
  `/visual/restore` POST with requestKey/expectedRevision and explicit target.
  Reference registration grants no provider or publication access by itself.
- `/api/life/worlds/:worldId/feed/posts/:postId/assets/:assetId` GET uses the
  existing scoped bearer. It is the only new route admitted by the feed proxy.

Use bounded typed source selectors for event-post and avatar operations. Bodies
cannot supply raw image prompts, filesystem paths, provider URLs, fake receipt
IDs or another actor. Owner status may show detailed reason codes; the viewer
projection only shows its authorized current image/asset state. Existing avatar
upload and global avatar read retain their caller contract and are not added to
the LIFE viewer proxy.

## Change map and activation proof

| Files | Create/store/decode/consume and required activation |
| --- | --- |
| `agents/{visual,visual-persistence}.ts`, `agent-schema.ts`, `store.ts`, `index.ts`; `test/agent-visual*.test.ts` | Explicit visual/grant/policy inputs → transactional snapshot/history/receipts → strict schema2 reopen → candidate/apply/pin/restore/current reference guard. Migrate real schema1 with learned state/candidates; corrupt/partial migration rejects unchanged; stale/pinned/newer-slot/duplicate apply preserves identity and bytes. |
| `world/image-{types,validation,material,persistence,schema}.ts`, `contracts.ts`, `schema.ts`, `store.ts`, `autonomy-schedule.ts`; `test/life-image*.test.ts` | Permitted post or real avatar slot → frozen intent/attempt/usage/delivery → strict schema8/history decoding → admission/recovery/serving. Two audiences, missing scene, hidden private changes, last-slot race, unknown restart/window, failed import and forged source/receipt are exercised with real files/stores. |
| `images/{contracts,conversation,life,life-assets}.ts`, reused `store.ts`, `jobs.ts`, `tools.ts`, client types/client/http; image tests | Exact owner/origin → manifest2/archived records → strict legacy migration → original polling/cancel/import/completion and final POST. Interrupted migration, foreign owner, lost submit, expired history, changed endpoint, duplicate archive, capacity before POST, reference revoke during await and cancellation/completion races. |
| `life/runner.ts`, `runtime.ts`, `scheduler.ts`, `fleet/life-runtime.ts`, `life-runtime-installation.ts`, `codex-fleet.ts`, `session-app.ts` | Trusted manual/scheduled trigger → owned image admission/source hooks → restart same jobs → actual provider stub and separate final delivery. Paused/manual, foreground, lease takeover, cold reads, repeated ticks and two worlds are concrete cases. |
| `fleet/avatar-assets.ts`, `life-image-routes.ts`, `agent-visual-routes.ts`, `life-routes.ts`, `server.ts`; web `life-proxy.ts` | Owner inputs/verified imports → receipts → scoped DTO/byte read. Real HTTP/Fleet/proxy checks cover hostile Host/Origin, guessed IDs/actors, malformed/oversized bytes, stale revision, response loss and later revoke. |
| Reused attachment/conversation/Markdown files and tests listed above | Preserve stable imports, native notice dedupe and exact session-scoped rendering. Imported consumer changes retain original behavior; fresh browser smoke is required before claiming visible image delivery. No new UI design. |

Current executable baselines are the060 native-enabled root tests/type/lint/build,
CI/dependency/history/doc gates recorded in `publication-check.json`, plus P runs
of original image-owner `image*.test.ts`/`ima2*.test.ts` and current AgentStore/
attachment tests. These directly name their target files. Root `bun test` discovers
new `packages/*/test` files; root/browser typechecks observe their configured
source trees. New filenames above are planned tests until their first RED run.
P verified the image-owner command at053976d:99 pass/307 assertions across7 files,
exit0 (`images-p-owner-tests.log`). Current core AgentStore/attachment command
at e8078fd:18 pass/61 assertions across2 files, exit0
(`images-p-core-tests.log`). No provider or installed state was used. The document
checker reads070/071 directly through its LIFE glob and passes13 plans/109 links;
these results establish executable baselines, not070 implementation.
070 C repeats affected and full required source checks on the integrated source,
records actual temporary DB/Fleet/manifest restarts and a real curl matrix against
synthetic ima2, and verifies teardown. Local fixtures do not qualify live ima2,
paid image output or human likeness judgment.

Enforcement is at application/store/client boundaries (E7): source/reference
selection, durable reservation, final generation POST, avatar CAS and asset read.
Privileged DB/filesystem writers, a dishonest provider and previously downloaded
bytes bypass those application controls; those are explicit residual limits.
No prompt label is called access enforcement. C syncs070/071,000, image plan009,
daily-life plan010, ARCHITECTURE/PLANNING/VALIDATION with exact proof and remaining080.
