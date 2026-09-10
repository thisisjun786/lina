# LINA LIFE engine and consumer contracts

LIFE keeps an authored world, individual knowledge, social relations and accepted
experiences beside ordinary LINA work. Its backend is connected to the existing
Codex task, persona, memory, image and internal publication owners. The LIFE
renderer and real-provider narrative/image quality are separate qualification
lanes. The 010–080 local engine acceptance passed 3,368 tests and independent
review. This guide describes the implemented contracts; it does not enable an
installation or select a world, schedule, audience, model or spending allowance.

See the [implementation roadmap](plans/life/000_plan.md),
[image qualification](plans/life/070_images_and_avatars.md) and
[integrated acceptance](plans/life/080_surfaces_and_acceptance.md) for evidence.
The Risu-inspired rules are a bounded declarative subset, not execution of Risu
scripts. Social resolution uses the pinned isolated Ensemble adapter; ordinary
LINA execution remains Codex with OpenCodex provider routing.

## Ownership and information boundaries

| Owner | Authoritative data | Consumer rule |
| --- | --- | --- |
| WorldStore | World versions, places/scenes/time, accepted event log, individual beliefs/experiences, social checkpoints and permitted growth | Use the purpose-specific projection; never send a complete snapshot to an actor, publication renderer or image provider. |
| AgentStore | User-authored identity, evolution choices, appearance, visual grants and avatar application history | LIFE growth does not overwrite authored identity. Avatar application uses its own compare-and-set transaction and preserves persona candidates and learned state. |
| Codex TaskManager | Task terminal/verification receipts and explicit sharing policy/outbox | Task completion is not proof of success. Only selected fields enter the world; original prompts, task identifiers and hidden logs are not world narration. |
| Ordinary conversation and memory | Actual conversation and source-linked factual memory | An explicit world binding shares permitted personality/relations. Event and secret disclosure is a separate setting. LIFE-derived material keeps its provenance and is excluded from factual recollection as required by050. |
| Publication store | Recipient-scoped posts, viewer grants, replies/reactions/reshares and finite later observations | A viewer capability grants a specific audience, not world-management access. Revocation/withdrawal fences later reads and effects. |
| Existing image owner | Frozen requests, provider UUID/status, imported bytes and delivery receipts | Generation, file retention, post attachment and avatar application are different facts. Reconcile the original request; never guess a successful retry after an unknown outcome. |

General projections live in [world/views.ts](../packages/lina-core/src/world/views.ts).
Ordinary delivery is wired by [world.ts](../packages/lina-runtime/src/world.ts)
and the [Fleet installation owner](../packages/lina-runtime/src/fleet/life-runtime-installation.ts).
The working/fiction boundary is specified in [050](plans/life/050_work_and_persona.md).
Directed A→B and B→A relations remain distinct. One agent's knowledge does not
become another agent's knowledge merely because they share a scene.

## Management API

The Fleet listener accepts management requests only on its existing trusted
loopback/Host/no-Origin boundary. JSON mutations require `application/json`.
The health endpoint additionally requires installation ownership. These endpoints
are not browser-public feed APIs. The UI owner must use a deliberately bounded
trusted bridge for management; the existing feed proxy does not forward arbitrary
world settings, health or image-management paths.

| Operation | Endpoint and request contract |
| --- | --- |
| Recorded storage health | `GET /api/life/health`; no database, model, image owner or scheduler is opened by this read. |
| Create/read/edit world drafts | `POST/GET /api/life/drafts`, `GET/PATCH /api/life/drafts/:id`; edits carry `expectedRevision` and `patch`. |
| Preview/confirm/suggest | `POST /api/life/drafts/:id/preview`, `/confirm`, `/suggest`; preview carries `expectedRevision` and `options`; confirm/suggest include the same `draftId`. Consume exact validated request types; confirmation is explicit. |
| Authored world and configuration | `GET /api/life/worlds`, `GET /api/life/worlds/:world/pack`, `GET/PUT /api/life/worlds/:world/config`; mutation carries `expectedRevision` and `config`. |
| Ordinary world binding | `GET/PUT /api/life/agents/:agent/binding`; mutation carries `expectedRevision` and v2 `selection` (`worldId`, `projectionPolicyRevision`, `conversationRecipientId`). Null world or conversation recipient has its defined disabled/private meaning. |
| Step and diagnostics | `POST /api/life/worlds/:world/step` with `idempotencyKey` and `expectedConfigRevision`; `GET .../status` and `GET .../steps/:step`. Diagnostics are management data, not actor tools. |
| Publication configuration/run | `GET/PUT .../publication/settings`, `POST .../publication/run`; use request key and exact configuration/settings revisions. |
| Viewer capability | `POST .../publication/viewers`; explicit `requestKey`, `expectedSettingsRevision`, `recipientId`. Revoke at `POST .../publication/viewers/:grant/revoke`. Never expose the management route to a viewer. |
| Image configuration/intents | `GET/PUT .../images/settings`, `GET/POST .../images/intents`, `GET .../images/intents/:intent`; generation and application controls are below. |
| Visual identity/history | `GET/PUT /api/agents/:agent/visual`, `GET .../visual/history`, `POST .../visual/pin`, `/apply`, `/restore`; use visual/profile revisions and stable operation keys. Approved reference upload uses its separate bounded byte/header protocol at `/visual/references`. |

The short `...` prefix above is `/api/life/worlds/:world`. Request parsers and
response owners are the canonical definitions:
[authoring requests](../packages/lina-core/src/world/authoring-request-validation.ts),
[world routes](../packages/lina-runtime/src/fleet/life-routes.ts),
[binding routes](../packages/lina-runtime/src/fleet/life-binding-routes.ts),
[publication routes](../packages/lina-runtime/src/fleet/life-publication-routes.ts),
[image routes](../packages/lina-runtime/src/fleet/life-image-routes.ts), and
[visual routes](../packages/lina-runtime/src/fleet/agent-visual-routes.ts).
Unknown fields are rejected. Management listings and feed listings have different
cursor contracts; do not reuse a feed cursor as a draft or intent cursor.

A revision conflict requires a fresh read and deliberate reconciliation. A
transport retry reuses the original operation key and payload. It must not mint
a new key, silently take the latest revision or reconstruct an old image from
current appearance/scene data.

## Viewer feed and image consumption

A viewer sends the minted bearer capability to the Fleet feed route or the
existing fixed-upstream [web LIFE proxy](../packages/lina-web/src/life-proxy.ts).
Keep capability values out of URLs, logs and public markup. The proxy bounds
paths, methods, bodies and forwarded headers and checks browser origin.

| Operation | Viewer endpoint |
| --- | --- |
| Feed page | `GET /api/life/worlds/:world/feed?limit=:limit&after=:cursor`; only documented `limit`/`after` fields are accepted. |
| One permitted post | `GET .../feed/posts/:post` |
| Read position | `GET/PUT .../feed/cursor` |
| Reply | `POST .../feed/posts/:post/replies` with `requestKey`, `expectedPostRevision`, `text` |
| Configured reaction | `PUT .../feed/posts/:post/reactions` with `requestKey`, `expectedPostRevision`, `reactionId`, `active` |
| Reshare | `POST .../feed/posts/:post/reshares` with `requestKey`, `expectedPostRevision` |
| Post image bytes | Use the permitted `image.url` returned by the post/feed response; keep the same viewer capability. Do not substitute a session attachment path or provider URL. |

Absent image data means the viewer has no currently deliverable image; it is not
proof of a provider failure. A withdrawn image can leave the text post visible.
Render only the returned public author/post fields. A viewer profile assembled
from these posts must not use the management AgentStore profile or shared-persona
projection as an unrestricted public biography. Author filtering is a client
view of already permitted items; `agentId` is not a supported feed query field.

For a manual event image, `POST .../images/intents` accepts selectors only:

```json
{
  "requestKey": "user-selected-image-operation",
  "expectedSettingsRevision": 1,
  "agentId": "configured-agent",
  "source": { "kind": "event_post", "postId": "permitted-post", "recipientId": "configured-audience" }
}
```

The values above are placeholders, not product defaults. An explicit request does
not require an automatic event rule. Call `POST .../images/intents/:intent/run`
with `requestKey` and `expectedRevision`; repeat that same operation to recover its
original result. `retry` additionally names a known terminal `previousAttemptId`;
`reconcile` names `attemptId` and `expectedRevision`. A completed event image is
attached by `/apply` with `attemptId`, `expectedRevision`, `avatarApply: null`.
The actual route schema is authoritative for each operation.

For portraits, selection freezes the configured periodic/event policy and the
approved visual identity. Automatic discovery does not generate a second image
for the same logical slot/event already selected manually. A candidate is not an
applied avatar. Pinning, manual/restore application and profile/visual revisions
are separate controls. An image withheld before candidate import remains reachable
through its original image intent/attempt; do not assume it is already listed in
`/visual/history`. Original-candidate application is bound to the attempt ID before
copying bytes; it reacquires the same capacity reservation when permitted.

The inspected image client supports one reference image. Unsupported multi-person
identity references are held explicitly, never silently truncated. Real likeness,
image relevance and consistent multi-character output still need image-owner
qualification. See [071](plans/life/071_image_execution_contract.md) and
[072](plans/life/072_image_authority_and_accounting.md).

## Operational states and recovery

Storage health is a recorded, read-only outcome:

```ts
type LifeStorageHealth =
  | { state: "unopened" | "open" }
  | { state: "rejected"; code: "LIFE_STORAGE_UNAVAILABLE" };
```

`unopened` is not a successful audit or configured simulation. `open` means the
store opened successfully, not that a model is connected or a step was accepted.
Use world diagnostics for run policy, missing configuration, usage and step state.
Keep raw diagnostics behind management access.

All worlds currently share `state/life/world.sqlite`. Strict recovery rejects a
corrupt checkpoint/history/schema, including an event revision outside the safe
range. Open failures include validation, filesystem and locking errors. Rejection is memoized until process restart: health and later management
reads do not repeatedly open or alter the file. Previously bound agents continue
ordinary chat without LIFE context, and ordinary tasks remain usable. All worlds
inside the rejected file require recovery; this is not per-world database
quarantine. Before opening an existing database, the runtime audits a private copy
of the main file and any WAL/rollback journal under the installation lock. A
rejected copy leaves the original files unopened and unchanged. Startup reads and
audits the database twice, so its cost scales with retained history size. Do not
reset or replace the damaged file automatically.

Pause stops new image selection/admission and automatic application. Recovery may
still account for an already completed result. A stale prepared request is locally
cancelled only when its manifest has no endpoint and the world ledger proves no
dispatch; its `no_post` settlement releases unused capacity. A dispatch marker or
unknown provider outcome keeps its reservation. A connection failure is not a
refund, and a cancel request is not proof of remote cancellation. Preserve original
UUIDs and reconcile available original-provider history; missing proof remains an
attention state. Task sharing restrictions and visual/viewer grants are checked
again at final dispatch and delivery boundaries.

## Offline checkpoint and restore

The existing checkpoint owner covers the configured state tree, including LIFE
SQLite/WAL and owned image/avatar/reference files. It refuses capture while the
installation or legacy session owners are active. Do not copy live WAL files
independently and label the result a checkpoint.

After stopping the installation, use the existing CLI and inspect the returned
checkpoint ID:

```sh
lina checkpoint create "Before LIFE changes"
lina checkpoint verify <checkpoint-id>
lina restore <checkpoint-id> /absolute/new-recovery-directory
```

Restore stages files into a new directory and writes `restore-review.json`; it
does not switch a running installation. Verify and reopen the restored owners
before choosing a separate activation procedure. Keep damaged originals and
checkpoint payloads private. There is no automatic in-place repair, rollback of
external provider actions or selective live-world restore in this contract.

Coverage gaps include data outside the selected local component roots,
shared/external Codex history, user workspaces, external skill roots, process
environment, provider credentials/runtime binaries and ima2 discovery at
`home/.ima2/server.json`.
Checkpointing a configured path does not necessarily include the external service
or file it points to. Consult [installation recovery](plans/installation.md) and
the [checkpoint CLI](../packages/lina-runtime/src/checkpoint-cli.ts).

## Acceptance and remaining owner work

| Requirement | Executable evidence and consumer boundary |
| --- | --- |
| R01 authored background and revisions | [020](plans/life/020_world_authoring.md): partial drafts, explicit confirmation, scoped Risu-style lore/rules and native author contracts. Renderer creation flow remains UI-owned. |
| R02 places/scenes/time/random events | [040](plans/life/040_autonomous_life.md): seeded weighted proposals, quiet steps, deterministic accepted history and restart. |
| R03 personality and directed relations | [030](plans/life/030_social_engine.md),040 and [integrated test](../packages/lina-runtime/test/life-e2e.test.ts): asymmetric accepted relations and shared ordinary growth; narrative quality is not measured by a trait value. |
| R04 experiences, beliefs and secrets | [010](plans/life/010_state_and_views.md),030,040: knower/disclosure boundaries, permitted reveals, belief corrections and source-linked experiences. Integrated sentinels remain absent from forbidden inputs. |
| R05 work changes later opportunity | [050](plans/life/050_work_and_persona.md) and the integrated test: actual task receipt/sharing path, no eligible event before permitted research, work contribution afterward. |
| R06 ordinary identity and factual memory | 050 and integrated test: same permitted relation projection, authored profile unchanged, explicit world binding and provenance-filtered memory. |
| R07 publication and interactions | [060](plans/life/060_publication.md): recipient feed, generated/user replies, reactions/reshares and bounded later observations; integrated viewer feedback reaches the next scoped experience. |
| R08 event pictures | 070 and integrated test: real local HTTP image transport, original request UUID, owned bytes, fixed-proxy serving and grant revocation. Actual model/image quality remains unqualified. |
| R09 scheduled/profile pictures | 070: policy slots/events, pin/history/restore, avatar-only CAS, capacity and pause recovery. UI controls and live likeness are separate. |
| R10 restart and duplicates | All units; integrated same-operation replay and [checkpoint test](../packages/lina-runtime/test/life-checkpoint.test.ts) reopen actual stores and retained files after process termination/restore. |
| R11 undecided settings | 020/040/060/070 parsers keep world, cadence, audience, model and resource budgets explicit/unset. Test fixture values are not installation defaults. |

The integrated test uses real local stores, the real task manager with synthetic
Codex RPC and a loopback image service. Earlier units separately qualify serialized
native Codex paths with local synthetic Responses. Neither proves a real provider's
character consistency, interesting narration, image likeness or renderer behavior.
The UI owner still needs creation/confirmation, timeline/thread/profile, image and
operational state views, keyboard/mobile/reload flows and browser evidence. No
external SNS account is connected by this engine.

Run the focused backend acceptance from the repository root:

```sh
bun test packages/lina-runtime/test/life-e2e.test.ts packages/lina-runtime/test/life-storage-isolation.test.ts packages/lina-runtime/test/life-checkpoint.test.ts
```

Final source gates and review results are recorded in 080. A passing fixture does
not authorize installed-state migration, provider spend, PR merge or deployment.
