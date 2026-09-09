# 072 — Image audit repairs: restoration, provenance and capacity

Status: A amendment to the same [070](070_images_and_avatars.md) work phase and
[071](071_image_execution_contract.md) implementation contract. Both independent
first-round audits returned FAIL. Main accepts all six findings (the generated
avatar serving omission was independently found twice) and the conversation
notice note; none is deferred to B without a contract. Original receipts are
`images-a-core-round1.md` and `images-a-runtime-round1.md` in the session evidence.

## Restore is a new application operation

Candidate identity is `(agentId, intentId, attemptId)`, independent of application
identity `(agentId, requestKey)`. Application input is exactly requestKey,
candidateId, expectedProfileRevision, expectedVisualRevision and
mode `automatic | manual | restore`; caller authority determines which mode is
allowed. Store the complete canonical payload digest and returned profile/visual/
application outcome. A same-key/different-payload request conflicts.

For all modes, first resolve an existing operation receipt. Return its original
outcome without another write, even when the current profile/visual state has
advanced. Never replay a historic receipt by reapplying its avatar. Otherwise:

- Automatic application requires current generation/application policy, the
  candidate's frozen visual/profile fence, newest admitted intent and unpinned
  state. Its deterministic operation key belongs to that candidate/attempt.
- Manual application and restore require current owner authority, current CAS,
  a real retained candidate/asset, current destination permission and capacity.
  They intentionally bypass the candidate's old visual/profile fence and latest
  automatic-slot test. They do not bypass source-reference or destination grants.
- A fresh manual/restore operation advances visual/profile revisions and records
  the selected hash without changing avatar policyRevision or learned/persona
  state. Old pending automatic work becomes stale. Repeating A→B→A uses distinct
  operation keys, while retrying any one key returns that exact original result.

Activation: generate/apply A then B; restore A, restore B, restore A again; lose
each response and reopen before retry. Assert actual current hash transitions,
distinct operation receipts, stable candidate/generation IDs, no extra POST,
unchanged persona candidates/dynamics, and no reapplication of an old receipt.
Audit existing avatar-only setters as well as the new route. A generic profile
patch containing only avatarId must preserve learning/candidates and advance the
visual fence; it must not mint a manual/global byte grant merely by naming a hash.
Mixed/nonvisual authored edits retain their existing persona-edit semantics.
The current reproduced `AgentStore.update({avatarId})` failure is in
`images-p-avatar-reset-repro.log`; test both the direct method and HTTP uploader.

## Resolved scheduling and event provenance

WorldStore persists a `ResolvedAvatarPolicy` before creating a slot. It records:
version1, id/digest, worldId/agentId, AgentStore avatarPolicyRevision and exact
policy snapshot, LifeConfig revision and resolved avatar mode/interval/limits,
image settings revision, and that setting's exact authored worldVersion or null
legacy reference. `scheduleKey` hashes exactly agentId/worldId, clock kind, epoch
and resolved interval. It excludes avatarPolicyRevision, resolvedPolicyId, visual
revision, config/settings revisions, applyMode, whilePinned, event-family lists
and all budgets. A non-cadence edit may create a new frozen provenance record,
but cannot change a slot's logical generation key.
An interval edit changes the schedule key even without an AgentStore policy edit.

The slot source is an explicit union:

- Wall: scheduleKey, slotIndex, dueAtMs, resolvedPolicyId.
- Steps: scheduleKey, slotIndex, dueLifeRevision, resolvedPolicyId.
- Event: resolvedPolicyId, actual eventId, worldRevision, lifeRevision,
  familyId, original accepted step/receipt identity, and the exact world-owned
  avatar-trigger permission reference/digest.

Periodic intent identity is the canonical hash of `{kind:"avatar_periodic",
worldId,agentId,scheduleKey,slotIndex}`. Event-triggered identity is the canonical
hash of `{kind:"avatar_event",worldId,agentId,eventId}`; event IDs are immutable
within their world. Event identity excludes resolvedPolicyId and every policy/
settings revision as well. Provenance-only edits cannot rediscover an old event.
Actual current source/permission checks remain mandatory despite stable identity.

Each source retains its creation provenance across restart. An effective policy
change does not rewrite an old slot, UUID, prompt, reservation or result. Unknown
old work is reconciled only. New admission uses current effective policy; old
prepared/ready work is held when its current admission/application checks fail.
Completed candidates remain available to explicitly authorized manual restoration.

`LifeImageSettings.avatarEventRules` is an explicit global-avatar trigger grant:
`{familyId, agentIds}[]`. AvatarPolicy.eventFamilyIds only selects among these
world-authorized rules. An ordinary friend-scoped post is not global-avatar
permission. The rule authorizes occurrence/timing as a trigger; avatar prompts
still use approved visual identity only, never event text, scene, secrets or
private relationships. No matching current rule means no event-triggered avatar.

WorldStore validates actual event/accepted-step/family/agent membership and the
original pack/settings/config references. AgentStore validates its original
policy/visual/reference snapshots and candidate lineage. Runtime
`images/life.ts` composes both historical owners before accepting a restored
foreign-owner reference, and both current owners plus live TaskManager authority
before POST/application. It does not import runtime or WorldStore into AgentStore.
Serving checks current source grants, not whether an old clock slot is still due.

Activation: in one periodic slot, change applyMode, whilePinned, image budget and
unrelated config separately; repeat discovery for prepared, ready and published
work. Each retains its original intent/generation ID and POST count. Repeat an
event after provenance/settings revisions and assert the same event intent.
Then change only LifeConfig interval; recover old unknown and old ready
slots; prove no old resubmit and a distinct current cadence key. Remove a family
or avatarEventRule after an event-triggered intent; reject new use/serving while
its original record still reopens. A private event without an explicit global
avatar-trigger rule never creates a global-avatar effect. Mutating private event
text cannot change the approved identity prompt.

## Exact reference and result lineage

The canonical AgentStore visual records include these strict shapes. Asset IDs
refer to verified owned bytes; they are not filesystem paths or upstream URLs.

```ts
type VisualReference = {
  version: 1;
  id: string;
  agentId: string;
  assetId: string;
  sha256: string;
  mime: "image/png" | "image/jpeg";
  size: number;
  origin:
    | { kind: "upload" }
    | { kind: "avatar"; avatarId: string }
    | { kind: "attachment"; binding: BotBinding; artifactId: string };
};
type VisualGrant = {
  version: 1;
  id: string;
  agentId: string;
  revision: number;
  subject:
    | { kind: "reference"; referenceId: string; sha256: string }
    | { kind: "text_identity"; identityDigest: string };
  providerUse: boolean;
  purposes: VisualPurpose[];
  revoked: boolean;
};
```

Grant history is immutable and exact; current grants retain the same ID with an
advanced revision. A grant's subject is immutable; a different hash/text identity
needs a different grant ID. Purpose removal/revocation is distinct from canonical-reference
selection. Frozen material includes the actual approved anchors/text digest,
reference metadata and `{grantId, revision, purpose}` references. Current use
requires the same subject/hash and current nonrevoked provider/destination grant;
historic parsing validates the original grant snapshot instead of guessing from
today's permissions. Provider submission requires providerUse and its destination
purpose; application/serving requires the destination purpose, not continued
permission to make another provider call. Text-only identity has the same explicit grant boundary.

An avatar candidate receipt retains candidateId, agentId/worldId, intentId/
attemptId, materialDigest, resolvedPolicyId, visualRevision, avatarPolicyRevision,
exact source/trigger proof, frozen grant references, providerGenerationId,
world artifact metadata/UUID and converted avatar SHA-256. It never replaces
reference lineage with only the result hash. Manual/legacy avatar provenance has
separate explicit variants with the verified hash and owner operation/source;
neither is a fabricated generated candidate.

At `/api/avatars/:hash`, `fleet/avatar-assets.ts` asks AgentStore for all retained
successful publication/application authorities for those exact bytes. Generated
authorities must pass current reference/destination and world trigger/work checks
through the storage-only runtime adapter before any read. An unregistered file
or an unapplied generated candidate is not a global serving grant. The route
keeps its URL and existing controller/agent-proxy caller shape, but denies a fresh
GET when no current authority remains. No fallback based only on file existence.

Preserve explicit manual uploads and known legacy/profile/seed-avatar provenance
as independent global-avatar authorities. Migration/initial inventory may
recognize those old references after byte verification; it must not classify an
unreferenced generated/orphan file as legacy. Legacy provenance is captured from
the actual pre-migration/profile/seed source, never inferred afresh from a later
generic avatarId patch. Identical bytes may have several owners: the hash route
serves them if any independent current global-avatar
authority allows those exact bytes. Revoking one lineage cannot revoke another
owner's separately authorized identical bytes. Once all such authorities are
revoked, both Fleet and existing agent-proxy GET deny. Responses reveal no lineage
list or agent counts. Existing downloaded bytes remain outside revocation.

Protected candidate/history previews resolve a specific agent/candidate and its
current permission; they do not create a global publication grant. Retain files
and receipts after revocation. Activation: apply→revoke→fresh Fleet/proxy hash GET
denied; preserved disk/DB reopen; unapplied candidate hash denied; valid manual/
legacy avatar remains readable; same hash with two generated authorities, revoke
one then both; add an explicit manual authority and verify the independent grant.
Revoking providerUse alone does not erase an independently permitted existing
avatar; revoking its avatar purpose does. Test both transitions.

## Separate image-count and storage reservations

The WorldStore count ledger binds world/intent/attempt and original dispatch time.
It distinguishes prepared reservation, ambiguous dispatch, known attempted count
and known zero-attempt release. Unresolved reservations are outside rolling-window
expiry. A known terminal provider outcome consumes one image at its original
dispatch time even on failure; count release is never an output-storage refund.
No cancellation acknowledgement alone settles generation or cost.

The final beforeSubmit owner transaction marks the actual attempt after current
guards and before the synchronous handoff to fetch. Known zero-attempt settlement
requires owned preflight evidence with no such dispatch marker. An HTTP error or
an `Ima2Error.outcome = rejected` after a marked POST is not proof of zero attempts.
Persist and test that distinction independently of the image runner's status.

Separate storage rows bind the same attempt to reserved file count/byte bounds
and category. World settings cover world result assets plus logical serialized
image metadata and manifest/archive bytes. Counts bound active/archived records;
the byte total includes both canonical and retained archives. Before POST reserve
the maximum accepted output size (at most2 MiB) plus bounded metadata growth.
Physical filesystem/SQLite overhead and an external disk filling remain failure
cases; a logical quota is not a guarantee of available filesystem space.

AgentStore visual settings additionally own explicit nullable `referenceLimits`
with maxAssets/maxTotalBytes and `maxHistoryRecords`; unset values deny new
reference/generated-candidate admission rather than guessing a long-running budget. These
cover owned canonical reference bytes and visual/candidate metadata separately
from world artifacts. Copying/approving a private reference reserves its bytes;
an independent reference grant does not depend on the old conversation keeping
its original attachment forever. Original conversation job/attachment caps remain
unchanged and do not fund LIFE storage.
Existing explicit manual avatar uploads/restores remain owner operations under
the original avatar storage ceiling and database capacity; they do not require
opting into provider references or automatic history budgets. They still write
the dedicated manual/application receipts and share installation capacity.

Avatar copies use an installation-wide AgentStore capacity ledger, shared by all
worlds and manual uploads. Preserve the existing managed-avatar safety ceiling
of128 files, each at most2 MiB; name it as a technical compatibility ceiling,
not a chosen LIFE quota. Runtime provides verified inventory of existing files,
including orphans. It never infers serving grants from capacity inventory.
Before avatar generation reserve a potential new file/max bytes here as well as
world storage/count. Before manual upload/import reserve actual bytes. A race
between two worlds or manual upload must compete in this same transaction owner.

World reservation then AgentStore destination reservation are separate durable
steps. POST requires both original receipts. If the second reservation fails,
release the first as known never-dispatched; a crash between them resumes or
releases without a provider call. Recovery must not manufacture a new manifest
for a linked UUID whose original manifest/archive is missing.

| Observed outcome | Count settlement | Storage settlement |
| --- | --- | --- |
| Authenticated no POST | Release unused count | Release unused world/avatar reservations |
| Ambiguous submit/history missing | Retain uncertainty | Retain bounded pending output reservations |
| Known provider failure/cancellation with no output | Consume one original attempt | Release unused output/avatar-copy capacity; keep charged metadata |
| Known result filename, import failed | Consume one original attempt | Keep recoverable-output capacity until import or explicit abandon; no new POST on download recovery |
| Verified world import | Consume one original attempt | Replace output reservation by actual retained bytes; release unused bound |
| Avatar copy already exists with same hash | No new count | Verify bytes, release duplicate copy reservation |
| New avatar copy imported | No new count | Convert reservation to actual installation bytes even if later application CAS fails |
| Application withheld before copy | No new count | Release unused avatar-copy reservation; retain actual world artifact/candidate for later manual apply |

An explicit abandoned import releases only unused storage; count/provenance and
dedupe history remain. A later authorized download first reacquires capacity.
Files written before a metadata receipt are counted as retained orphans; matching
UUID/hash adoption converts their accounting once, while conflicting bytes reject.
Never delete history or refund count to escape capacity. Archive movement releases
active-record capacity only after an immutable record and dedupe reference are
durable; archive bytes remain counted.

Activation: known failed provider uses one image but frees output space; successful
small output frees the unused bound; import failure/restart/adoption charges bytes
once; two worlds plus manual upload compete for the final avatar slot before POST;
existing-hash copy does not double-charge; pin/CAS failure retains generation and
world bytes while releasing an unused destination copy; quota/disk failure never
creates a replacement generation.

## Reachable scheduler and notification owners

Add `imageWorldIds()` to the scheduler/runtime composition, unioned with simulation
and publication IDs. It includes current image/avatar configurations and worlds
with retained prepared/unknown/recoverable/delivery-pending image records, even if
publication or current generation settings are now disabled. Legacy avatar-only
worlds need no autonomous pack, director route or publication configuration.
Recovery eligibility never grants new generation/application authority.

`FleetLifeAgents` in `fleet/life-runtime-state.ts` notifies successful effective
visual policy/grant/pin/application changes and affected worlds; read/noop/replay
does not fabricate a change. Image settings/intent/retry/application endpoints
notify the same existing runtime. ImageJobs observation/import/completion receipts
signal pending delivery after commit, and installation resume enumerates retained
work before scheduling new work. Update manager, life-runtime-installation and
life-runtime composition to carry these callbacks; cold reads do not instantiate
execution owners. No new timer or second image engine is introduced.

Add the new visual management routes to `web/agent-proxy.ts` with explicit methods,
body limits and CAS headers; existing POST/PATCH-only and64 KiB generic limits do
not suffice for visual PUT or reference bytes. Keep fixed upstream, browser-origin
and bounded forwarding checks. Global avatar GET still runs its new backend
authority guard; the proxy cannot turn a denied result into bytes.

Activation: avatar-only legacy startup; retained work after all generation/
publication configuration is disabled; enable policy while the loop has no
deadline; effective grant/pin/application change; import→delivery wake; replay/read
causes no wake; repeated paused recovery makes zero POST/application; unknown work
yields a finite wait and leaves another world/conversation usable. New core
`agents/visual-capacity.ts` and the runtime/Fleet/proxy files above are added to
071's change map, with focused tests for every branch. No070 implementation is
claimed until these contracts pass A and their actual B/C proofs exist.
