# 060 — LIFE feed and social interactions

Status: P revalidation at `15485e2`, 2026-09-08. Depends on completed040–050. Prior D direction: “execute060 scoped LIFE posts, replies, reactions, reshares and finite causal inputs, reusing current world disclosure/work-authority boundaries and040 execution owner.” This unit follows that direction. Exact reaction vocabulary, visibility and activity limits remain explicit settings.

## Unit contract

| Field | Scope |
| --- | --- |
| Loop / trigger | Satisfy-spec, continuing the user-authorized unattended roadmap. C4 for viewer authority, persistence and native disclosure. |
| Goal | View permitted agent posts; reply, react and reshare once; agents may respond and acquire scoped experiences that affect later LIFE. |
| Non-goals | External SNS, UI rendering, image generation or avatar application, a new provider client, invented world/audience/cadence/budget defaults, installed-user-data writes, push/merge/deploy. |
| Verifier | Actual SQLite reopen/migration, protected HTTP and web proxy, model adapter/final gateway probes, shared budget/lease and subsequent LIFE input tests; focused RED/GREEN and repository source gates. |
| Stop / outcomes | Complete060 after acceptance rows and independent review pass, then continue070–080. Missing optional settings yield explicit not-configured behavior, not guessed defaults. Synthetic-model proof is transport/behavior proof only. |
| Artifact / resources | This numbered document and task-owned `publication-*` evidence; existing goalplan ledger. No user token/time budget. Temporary state and local synthetic providers only. |
| Delegation / escalation | Main owns core source/material/schema/model-request/usage contracts and feedback into autonomy. After shared contracts freeze, bounded workers own runtime publication execution, protected HTTP authority, and web proxy in disjoint files. Main reclaims after two distinct failed implementations. Additional delegation needs a recorded amendment. Real external service/data authority remains separate. |

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-core/src/world/publication.ts`, `publication-types.ts` | Only event audience → explicit publication policy, immutable permitted material, post/reply/reaction/reshare state and receipts |
| MODIFY core `world/schema.ts`, `store.ts`, `views.ts`, `life-types.ts`, `life-validation.ts`; NEW `publication-schema.ts`, `publication-persistence.ts`, `publication-validation.ts`, `publication-material.ts`, `publication-input.ts` | Durable side-effect intent → transactional publication delivery, audience checks, actor observation inputs and cursors; strict v6→v7 migration |
| NEW `packages/lina-runtime/src/life/publication.ts`, `interactions.ts` | Event history only → candidate selection, perspective narration, validation, publish-once and finite interaction chains |
| MODIFY runtime `fleet/life-routes.ts`, `fleet/server.ts`; web `src/server.ts`, NEW `src/life-proxy.ts` | Authenticated world-scoped feed/interaction API with explicit viewer identity |
| NEW core `test/life-publication.test.ts`, `life-publication-schema.test.ts`, `life-publication-input.test.ts`; runtime `test/life-publication.test.ts`, `life-publication-routes.test.ts`, `life-publication-gateway.test.ts`; web `test/life-proxy.test.ts` | Privacy, once-only posting, reply causality, revoked access and direct API negatives; existing route regression is `life-runtime-routes.test.ts` |

Field chain: accepted event's durable publication intent → audience-filtered `PublicationMaterial` snapshot with policy revision/digest → persisted narration receipt and `Post`/`PublicationReceipt` → authenticated feed API, actor observation queue, image brief and UI. User interactions originate in authenticated endpoints with request key/expected revision, persist before response, then enter the same deduplicated LIFE input path. Unknown type/audience variants reject on parsing.

## Contract diff

```ts
type PublicationSource =
  | { kind: "event"; eventId: string; worldRevision: number }
  | { kind: "reply"; parentPostId: string; interactionId: string };
interface PublicationMaterial {
  id: string;
  worldId: string;
  authorAgentId: string;
  source: PublicationSource;
  policyRevision: number;
  audience: AudienceRef;
  allowedClaims: PublicClaim[];
  permittedScene: PublicScene | null;
  digest: string;
}
// publishOnce(intentId, payloadDigest, post): same -> original receipt;
// different payload -> conflict. Post and receipt commit together.
```

Add world-owned `life_publications`, `life_publication_receipts`, `life_interactions` and `life_read_cursors` with unique world/intent or viewer/request keys. Separate state categories: candidate, awaiting material, ready, published, withheld, withdrawn, failed. Preserve causal/publication revision and failure reason codes without private body logging. Deleting/withdrawing a post leaves the receipt/tombstone so reprocessing cannot recreate it. Counts and notifications obey the same audience filter as bodies.

Agents decide whether an event merits sharing, what perspective to take and whether to reply. Narration receives only permitted material and shareable voice/growth, not the agent's unrestricted knowledge. Text, captions, alt text, image prompts, filenames, quoted parent text, errors and metadata all use this boundary. No free-form private rationale is passed for “sanitization.” Validate generated statements against allowed claims; unsupported factual additions are rejected or explicitly marked imaginative within the authored constraints.

Separate feed viewing from a world-author inspection mode. The authenticated user is not automatically every agent or every audience. Preview what a recipient can see. A reshare cannot broaden the original audience; reject or redact into a new independently authorized post. Replies intersect parent visibility with the author's sharing policy. A user reaction is a new input, not an immediate authoritative relationship edit. Agents can observe it and form their own asymmetric responses or ignore it.

Prevent runaway loops with stored chain ID, depth, per-author cooldown, deduplicated observation IDs and configured activity budgets. Reading/reloading the feed never creates an interaction. Reactions have stable add/remove semantics, not a toggle vulnerable to retry; resending the same reply request returns the original post. Agent replies use the 040 scheduler/usage owner, not a timer per post. Include `no_reply` as a valid outcome.

Recheck current permission before dispatching narration/image material and before publishing. Once input bytes reached a provider or content reached a viewer, later withdrawal cannot recall that disclosure. Restriction changes invalidate not-yet-published candidates and revoke application access to withdrawn assets. Store frozen content for historical consistency but do not serve it without current authorization.

## Acceptance scenarios

| Trigger | Observable result |
| --- | --- |
| One event, two recipients with different permissions | Different permitted materials/posts; no hidden IDs, counts or attachment links in unauthorized response |
| Generate with secret in author's perception but not public material | Captured narration prompt and generated-output validator contain no private source; disallowed addition rejected |
| Publish transaction succeeds, callback response is lost | Retry/poll/restart returns one post and original receipt; changed caption on same intent conflicts |
| Duplicate reply/reaction/reshare from UI retry or two tabs | One logical interaction and one LIFE observation; remove-reaction remains idempotent |
| Recursive agents answer each other; same source re-observed | Chain/cooldown stops further generation; no infinite queue, `no_reply` allowed |
| Broadened reshare, revoked policy during generation, deleted parent | Reject/withhold/withdraw deterministically; no new access via quoted text or stale URL |
| User replies to a post, next agent step runs | Reply becomes a scoped experience and can influence later action; loading feed alone has no effects |

API handlers and scoped store queries are the final application boundary (E7). Client hiding and prompt instructions are not enforcement. Direct privileged storage access and previously downloaded content remain outside revocation. Planned test files are not yet runnable. SoT: `docs/PLANNING.md`, `docs/plans/platform/010_agent_daily_life_ideas.md` and `docs/VALIDATION.md`.

## Revalidated source and selected extension

The source baseline is050 `15485e2`. Its C receipt combines the native-enabled2,269-test baseline with76 affected tests after the final four-file memory repair; types, lint/build/CLI, CI metadata and document checks pass. Those commands exist and cover package tests/source; they do not prove this new publication behavior. Root `bun test` discovery covers `packages/*/test`; root/browser TypeScript configs cover the planned source and tests. The existing document verifier directly reads060. New test names below remain future tests until their RED run.

`life-types.ts:186` already defines a durable `publication_candidate` effect with eventId. `autonomy-transition.ts:319` produces it with the accepted LIFE commit. `WorldStore.publication` (`store.ts:593`) applies disclosure and destination work ancestry, but needs a separate current TaskManager source check. `LifeConfigInput` (`authoring-types.ts:226`) already owns publication mode and recipient IDs; reuse these fields. A separate versioned publication-settings record adds only feature-specific authority/interaction limits, avoiding duplicate mode/audience settings or changes to old frozen config JSON.

The independent runtime inventory is `publication-p-runtime-inventory.md`. It confirms that `LifeRunner.run` owns single admission/foreground cancellation/drain, the scheduler has one wake loop, and `LifeModelPort` already provides prepare/complete/reconcile. Existing model requests are step-owned, and fleet selection correctly rejects accepted steps. A publication job must therefore have its own explicit model-request identity; it must never borrow an accepted step's authority or pretend to be an actor request.

Use an explicit `LifeModelRequest` union: rename the current interface to the planned v1 member `StepModelRequest` and preserve its serialized bytes; version2 has `jobId` and lane `publication`, without `stepId`. The same native adapter, gateway, provider routing and native journal handle both. New publication-model rows reference publication jobs. Refactor the existing receipt mechanism for the two fixed table owners and aggregate both ledgers for world usage. This keeps one reservation/accounting implementation and supports candidate effects from older non-autonomous LIFE commits too. Do not insert fake steps, append new models to accepted step histories, or create a second budget pool.

## Frozen persistence and authority contracts for A

The proposed public types below are consumed only after strict parsing at their owning boundaries. Their detailed codecs are B work, not existing APIs.

```ts
interface PublicationSettings {
  version: 1;
  worldId: string;
  revision: number;
  agentRecipients: { agentId: string; recipientId: string }[];
  reactionIds: string[];
  maxChainDepth: number;
  maxActionsPerChain: number;
  perAuthorCooldownSteps: number;
  maxJobsPerRun: number;
}
type PublicationPrincipal =
  | { kind: "viewer"; grantId: string }
  | { kind: "agent"; agentId: string };
type PublicationSegment =
  | { kind: "claim"; claimId: string }
  | { kind: "imaginative"; text: string };
type PublicationDecision =
  | { kind: "no_post" | "no_reply" }
  | { kind: "post"; segments: PublicationSegment[] };
// Existing request v1 remains unchanged. New request branch:
type PublicationModelRequest = Omit<StepModelRequest, "version" | "stepId" | "lane"> & {
  version: 2;
  jobId: string;
  lane: "publication";
};
```

Settings are absent until the owner explicitly saves all fields. Zero/empty values may explicitly disable behavior where valid; there are no silently chosen reaction IDs, viewer recipients, cooldowns or spend allowances. Existing LIFE config still supplies publication mode/recipientIds, the actor model route, token window and evaluation bounds. Job creation requires the relevant explicit settings and current recipient membership. Bounds against unsafe integers/oversize inputs are implementation limits, not product defaults.

Add world schema7 tables for publication settings/history, viewer grants, jobs/attempts, publication-model receipts, posts, publication receipts, interactions, observation receipts and read cursors. Each has strict JSON/row-key/digest validation, required FKs and uniqueness. Job/post identity is world + source intent + author + audience; retries never create a second logical post. Attempts retain their own material/model receipt. A changed payload under the same request key conflicts. Withdrawn/deleted posts retain tombstones and receipts and cannot be recreated by reprocessing an old intent. Legacy v6 migration audits all existing data before DDL in the surrounding transaction; unknown/corrupt schemas fail unchanged. No configuration, viewer grant, post or model call is invented during migration.

The material snapshot includes world/author/source identity, recipient set, settings and disclosure revisions, exact allowed claims/scene, current work ancestry proof, shared persona/profile revision, content digest and chain metadata. Build it exclusively from publication projections for every recipient; a joint audience uses their intersection. Per-recipient jobs may produce different permitted posts for the same event. Public material IDs are scoped to that snapshot. A narrator gets only these claims, permitted scene, authored display name/voice and safe shared behavior; no unrestricted perception, biography, task body or growth rationale. Unknown claim references reject; claim segments render the canonical allowed text. Free text is an explicitly imaginative segment, retained as such in API/model/image contracts. It cannot masquerade as a supported factual claim. User reply text remains separately tagged user-authored content.

Viewer authentication is an explicit capability, not a Host header. The existing loopback management boundary plus current installation ownership may mint a random viewer token for one world and one configured recipient. Persist only its hash, grant ID/revision and revocation state; return the token once without logs. Feed requests require that bearer token. Principal and recipient come from its current grant, never body/query/forwarded identity. Agent reads use a trusted in-process scope resolved from `agentRecipients`, never a browser-provided agent ID. World authors retain their separate management inspection path. Token revocation/recipient removal invalidates read, interaction and cursor access after awaits. Local privileged management and direct DB writers remain trusted boundaries, not a multi-user account system.

Reads filter current source and destination permission before bodies, counts, parent quotes, cursors and future attachment references. A source revoke must block even when the world bridge has not delivered its restriction. Read queries have no model calls or new LIFE inputs. Use a storage-only Fleet accessor: opening the feed must not call the current authoring getter that starts background execution. A schema-open audit is allowed; no simulation work is triggered by reading.

### HTTP and UI consumer contract

All paths below begin `/api/life/worlds/:worldId`. Management routes retain the existing exact loopback Host/no-Origin check and current installation owner, and are not exposed by the feed proxy. Feed routes require the current world-scoped bearer in addition to ingress checks. The web proxy admits only the feed subset, validates browser Host/Origin using the existing policy, rejects credential-bearing URLs/redirects, and forwards only the explicitly scoped bearer, method and bounded JSON to its fixed configured upstream. Arbitrary browser Cookie/Authorization does not confer installation management rights.

| Path / method | Exact purpose and payload |
| --- | --- |
| `/publication/settings` GET/PUT | Owner inspection or `{expectedRevision, settings}`; all settings fields explicit. |
| `/publication/viewers` POST | Owner `{requestKey, expectedSettingsRevision, recipientId}` creates a grant for a configured recipient and returns its token once; replay never exposes the old plaintext token. Lost token requires explicit revoke/new grant. |
| `/publication/viewers/:grantId/revoke` POST | Owner `{requestKey, expectedRevision}`; durable idempotent revocation. |
| `/publication/run` POST | Owner `{requestKey, expectedConfigRevision, expectedSettingsRevision}` enters the shared bounded runner admission; no caller model prompt or guessed authority. |
| `/publication/jobs/:jobId` GET, `/publication/jobs/:jobId/retry` POST | Owner inspect; explicit retry `{requestKey, expectedRevision}` only when prior dispatch is known and source/current policy allow another attempt. |
| `/publication/posts/:postId/withdraw` POST | Owner moderation `{requestKey, expectedRevision}`; tombstone and future-access withdrawal without erasing receipts. |
| `/feed` GET, `/feed/posts/:postId` GET | Bearer viewer's scoped feed/detail. Only feed accepts bounded `after` and `limit`; cursor is tied to world/grant/current permission and reveals no hidden row count. No recipient/agent/author selectors. |
| `/feed/posts/:postId/replies` POST | `{requestKey, expectedPostRevision, text}`. Actor and audience come from the bearer scope and parent intersection. |
| `/feed/posts/:postId/reactions` PUT | `{requestKey, expectedPostRevision, reactionId, active}`. Stable add/remove, never toggle. |
| `/feed/posts/:postId/reshares` POST | `{requestKey, expectedPostRevision}`. The grant's recipient must already be allowed; no broadened audience supplied by the client. |
| `/feed/cursor` GET/PUT | Scoped read state; PUT `{expectedRevision, postId}` must name a currently visible post and creates no interaction. |

Post responses preserve typed supported/imaginative/user-authored segments, author display identity, visible parent/chain metadata, scoped reaction state and current revision. No raw task IDs, source proofs, tokens, other recipients or hidden attachment references are serialized. Until070, no image is claimed attached. UI rendering/token storage remain with their owner; the backend/proxy contract and real HTTP verification are this unit's work.

## Execution, accounting and causal input

Extend the existing runner admission with a publication-drain operation using the same active slot, foreground checks, abort handling, clock and world lease. The existing scheduler may drain configured automatic publication work at its current wake/step boundary; manual publication requests use the same admission. No per-post timers and no separate native/provider instance. Unknown model outcomes reconcile from the existing native journal before any retry. Never-dispatched reservations may be released; dispatched/unknown usage remains reserved across lease loss, settings changes and restart.

A job freezes its permitted material and deterministic request ID before native preparation. Publication jobs have one narration call per attempt; `maxJobsPerRun`, chain limits/cooldown, existing `maxModelCalls` and shared world token usage jointly bound a drain. Both autonomous and publication reservations see each other's pending/spent/unknown records in the same SQLite transaction. The current fleet selection branches explicitly on request version: v1 retains its existing step guard, v2 resolves the saved publication job and validates original material, grant/settings/profile/model route and TaskManager proof. The same check runs immediately before the gateway fetch. Completed native receipts replay without inference; a publication commit still requires current authority.

Reply/reaction/reshare mutations first authenticate the principal and inspect a currently visible parent. They persist a request receipt plus one interaction atomically. Reaction add/remove sets explicit state; retries and an already-equal state produce no duplicate observation. Reshare audience is a subset of the original current audience; reply audience intersects its parent and author policy. No parent text survives a later permission failure in output or model input. Agent jobs may choose no_reply/no_post, which is a durable terminal decision. A job failure remains inspectable and needs explicit eligible retry; unknown dispatch is not silently retried.

Each effective permitted interaction produces deduplicated recipient observation receipts and a trusted `LifeInput` version3 branch (`source.kind = publication_interaction`). It carries interaction/post IDs, the actual principal, recipient agent, typed action, permitted text and root/depth. Only the publication transaction can admit this branch; the generic application-input API still cannot mint trusted publication/work sources. Extend parsing, exact replay, source membership and permission filtering for every consumer.

New autonomy steps use a version3 envelope with a frozen publication-input authority snapshot. Preserve version1/2 saved steps/model JSON exactly. Revocation changes future eligibility and stales pending use; old accepted fictional events remain history. At step acceptance, permitted feedback becomes a scoped neutral experience/claim and is consumed once. Actor/reflection input contains only that agent's allowed feedback. Existing optional reflection may change mood/goals/habits/attitudes using that experience; the HTTP interaction itself never directly writes personality or relationships. Root/depth and per-chain action receipts survive all agent replies, reshares and observation inputs, preventing a reply from resetting the chain. Exhausted chains remain visible with stopped processing, without further inference or recursive inputs.

## Complete field/file chain and ownership

| Contract | Create / serialize / decode / consume |
| --- | --- |
| Settings and viewer capability | NEW core `publication-types.ts`, `publication-validation.ts`, `publication-persistence.ts`, `publication-schema.ts`; NEW runtime `fleet/life-publication-authority.ts`, `life-publication-routes.ts` create through protected management; token hash is persisted/strictly decoded; routes/service resolve current branded scope; NEW web `life-proxy.ts` forwards only the scoped bearer to fixed upstream. |
| Material, job, decision and posts | NEW core `publication-material.ts`, `publication.ts`, `publication-audit.ts`; MODIFY world `store.ts`, `schema.ts`; exact JSON/digests and attempt links decoded on read/reopen. NEW runtime `life/publication.ts` consumes only frozen material; feed/proxy and070 image contract consume scoped post projections. |
| Model request v2 and shared usage | MODIFY core `autonomy-types.ts`, `autonomy-record-validation.ts`, `autonomy-model-receipts.ts`, `autonomy-persistence.ts`; NEW `publication-model.ts` owns job request/persistence and shared accounting wiring. MODIFY runtime `life/model-port.ts`, `actor.ts`, `runner.ts`, `runtime.ts`, `scheduler.ts`, `fleet/life-runtime.ts`; MODIFY Codex `life-model-validation.ts`, `life-model-policy.ts`, `life-model-journal.ts` only where needed by the union. Native adapter/gateway remain sole outbound owner. All v1-only consumers must narrow explicitly; unknown versions/lanes reject. |
| Interaction input v3 and step v3 | NEW core `publication-input.ts`; MODIFY `life-types.ts`, `life-validation.ts`, `life-persistence.ts`, `autonomy-types.ts`, `autonomy-source.ts`, `autonomy-step-records.ts`, `autonomy-persistence.ts`, `autonomy-transition.ts`, `autonomy-views.ts`; owning transaction creates/input receipt serializes/strict parser restores/current recipient filter and actor/reflection consume. Existing work and application inputs retain their versions. |
| Installed access and UI contract | MODIFY runtime `fleet/life-routes.ts`, `life-runtime-installation.ts`, `manager.ts`, `server.ts`; NEW route/authority helper above. MODIFY web `src/server.ts` plus narrow `life-proxy.ts`. No client component edits. Explicit feed/post/interaction/grant/settings/drain/cursor contracts are documented for the UI owner. |
| Verification | NEW core `test/life-publication-{schema,material,store,model,input}.test.ts`; runtime `test/life-publication-{runner,authority,routes,gateway}.test.ts`; web `test/life-proxy.test.ts`. MODIFY actual existing affected tests for new strict union branches and legacy fixture expectations, without removing old assertions or raising timeouts. |

Within B, main establishes and tests core codecs/storage/authority and native request versioning first. Once those signatures are concrete, a runtime worker owns `life/publication.ts`, `interactions.ts` and publication runner tests; a management worker owns the two new fleet publication helpers and tests; a proxy worker owns only web `life-proxy.ts`, its tests and server dispatch. Main retains shared runner/fleet installation/autonomy/native files to avoid overlapping writes. Main inspects every returned diff and original RED/GREEN proof before integration.

## Additional activation and failure evidence

| Trigger | Required observation |
| --- | --- |
| Read feed repeatedly before/after runtime opening | Same authorized content; zero new jobs, interactions, input rows, model requests and scheduler starts caused by the read. |
| Missing/forged/revoked bearer, guessed agent/recipient, foreign Origin, redirect/query/path confusion | Sanitized403/404, no private metadata or credential forwarding; direct runtime and actual proxy tested. |
| Pause request JSON or native preparation, then revoke owner/grant/disclosure/source/destination | Final authority check rejects; gateway receiver observes zero input or post transaction writes zero post. A response already sent is never claimed recalled. |
| Two DB connections reserve last shared tokens for simulation/publication | At most one reservation succeeds; unknown usage keeps both consumers stopped across reopen/window change. |
| Old completed v1 request plus new v2 publication job | Exact old bytes/replay remain; new request carries jobId, no forged stepId, uses one real isolated Codex request and its receipt. |
| Kill after intent, model receipt, post transaction or interaction receipt | Reopen resumes/reconciles from owned records; no duplicate provider dispatch/post/reaction/experience, unknown stays withheld. |
| Saved post/receipt/material/chain/grant/model/observation projection corrupted | Strict actual-file reopen rejects and rolls migration back; no inferred authority or shortened ancestry. |
| User reply observed by one agent, then next step and restart | Scoped experience/input consumed once; another agent sees no hidden reply; allowed future action/growth can differ while authored identity remains unchanged. |
| Agent A/B repeatedly reply, reshare or encounter the same post | Persisted root/depth/action/cooldown gates fire; valid no_reply remains terminal; retries cannot mint a fresh root. |

E7 executing surfaces are the protected management handler, bearer resolver, scoped store/service read, shared runner reservation and final native gateway. Bypass paths are privileged local management/DB edits, a deliberately dishonest configured verifier/provider, and previously downloaded content. Residual risk is stated narrowly: projection integrity, application access and once-only durable effects are enforced at these surfaces; semantic truth or whole-host compromise is not certified. Prompt labels alone are explanatory, not access controls.
