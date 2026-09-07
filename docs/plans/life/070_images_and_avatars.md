# 070 — Event images and evolving profile pictures

Status: proposed integration. Depends on [060](060_publication.md) and the image-owner implementation. Reuse the existing image engine; do not write a second ima2 client or provider router.

## Observed integration baseline

The image-owner source at `053976d6fed2dce32be603b145a6c97e4e52de6f` supplies `images/client.ts`, `store.ts`, `jobs.ts`, tools and session integration. Its `ImageJobStore` is a strict v1 JSON manifest under a session binding. `(requestId, callId)` deduplicates a job; its separate UUID identifies upstream generation and attachment. `deliveredEntryId` records a conversation completion, not an SNS post.

States are `prepared`, `submitting`, `queued`, `running`, `post_processing`, `uncertain`, `cancelling`, `completed`, `failed`, `cancelled`. Recovery reads the same upstream ID; uncertain work is not resubmitted. The inspected client contract pins ima2 3.14.0 and accepts at most one reference image. The adapter enforces PNG/JPEG and existing attachment limits. Recheck the integrated revision and capabilities before implementing this phase; do not silently assume multi-reference support.

`WorldImageBrief` v1 currently has event/non-null scene/appearance references but no runtime consumer. `snapshotAt()` returns a trusted full snapshot, not publication-safe data. `AgentProfile.avatarId` uses a hash-addressed avatar store, while generated attachment IDs are UUIDs. Their identifiers must never be interchanged.

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

Avatar scheduling creates a stable `(agent, policy revision, slot)` intent. Optional event-triggered and periodic slots use the chosen world/real-clock policy, not wall time guessed from events. Avatar pin prevents automatic replacement; generation may be skipped or retained as a candidate according to explicit settings. Keep history and allow restore without regenerating. Add `applyAvatarOnce(intentId, expectedVisualRevision, assetRef)` with avatar history/pin/application receipt in the same AgentStore transaction. User appearance/avatar edits advance visual revision; stale results remain history candidates. Do not use generic `AgentStore.update()` unchanged: it also clears persona candidates and couples unrelated edits. Avatar-only updates must not alter personality/evolution/reflection state.

Add `agent_visuals`, `agent_avatar_history` and `agent_avatar_receipts` as recognized AgentStore-owned tables with agent/intent uniqueness. Its current column and foreign-table checks must explicitly recognize the migrated shape. Migration preserves profiles, learned dynamics, pending persona candidates and old avatar references; unknown/partial schemas reject. Store visual revision/pin policy/reference provenance alongside history, then decode them in `visual.ts` before avatar scheduling, API preview or application. A file import can precede the transaction, but it is not an applied avatar until the transactional receipt exists; unreferenced imports can be reclaimed without losing completed receipts.

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
