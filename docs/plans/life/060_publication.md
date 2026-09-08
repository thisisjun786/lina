# 060 — LIFE feed and social interactions

Status: local implementation, full source checks and two independent implementation re-reviews passed, 2026-09-08. The verified source descends from `7c44c91e`; exact file hashes and final receipt are in the session evidence. Depends on completed040–050. Prior D direction: “execute060 scoped LIFE posts, replies, reactions, reshares and finite causal inputs, reusing current world disclosure/work-authority boundaries and040 execution owner.” This unit follows that direction. Exact reaction vocabulary, visibility and activity limits remain explicit settings. Image/avatar integration070 and final consumer acceptance080 remain; this is not whole-LIFE completion.

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
| Core `world/publication.ts`, `publication-types.ts`, `publication-material.ts`, `publication-reply-material.ts` | Event audience → explicit publication settings, immutable permitted material and typed event/reply jobs |
| Core `world/publication-schema.ts`, `publication-persistence.ts`, `publication-jobs.ts`, `publication-posts.ts`, `publication-interactions.ts`, `publication-reply-posts.ts`, `publication-runs.ts`; existing `schema.ts`, `store.ts` | Durable intents → transactional delivery, interaction receipts, historical audits and strict v6→v7 migration |
| Core `world/publication-feed.ts`, `publication-grants.ts`, `publication-cursors.ts`, `publication-evidence.ts`, `publication-ancestry.ts`, `publication-chains.ts`, `publication-experience.ts` | Current viewer authority, finite causal activity, scoped feedback and retained historical provenance |
| Runtime `life/publication.ts`, `publication-scheduler.ts`, existing `runner.ts`, `runtime.ts`, `scheduler.ts`; Codex `life-model.ts`, `life-model-journal.ts` | Shared execution/usage/leases, narration and native reconciliation for one frozen run |
| Runtime `fleet/life-publication-routes.ts`, existing `life-routes.ts`, `manager.ts`, `codex-fleet.ts`, `life-runtime.ts`; web `life-proxy.ts`, `server.ts` | Authenticated world-scoped feed/interaction API, live work-source check and fixed-upstream proxy |
| Core/runtime/Codex `test/life-publication*.test.ts`; web `test/life-proxy.test.ts` | Privacy, recovery, publish-once, feedback, finite replies, native dispatch and actual route regression |

Field chain: accepted event's durable publication intent → audience-filtered `PublicationMaterial` snapshot with policy revision/digest → persisted narration receipt and `Post`/`PublicationReceipt` → authenticated feed API, actor observation queue, image brief and UI. User interactions originate in authenticated endpoints with request key/expected revision, persist before response, then enter the same deduplicated LIFE input path. Unknown type/audience variants reject on parsing.

## Original planning sketch

This sketch records the initial boundary, not the serialized API. The subsequent
frozen contracts and [reply contract](061_reply_contract.md) refine it. Actual
public types/codecs live in `publication-types.ts`, `publication-validation.ts`,
`publication-record-validation.ts` and `publication-reply-records.ts`.

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

API handlers and scoped store queries are the final application boundary (E7). Client hiding and prompt instructions are not enforcement. Direct privileged storage access and previously downloaded content remain outside revocation. Actual runnable tests are the core/runtime `life-publication-*.test.ts` suites, Codex publication tests and web `life-proxy.test.ts`. SoT: `docs/PLANNING.md`, `docs/plans/platform/010_agent_daily_life_ideas.md` and `docs/VALIDATION.md`.

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

Post responses preserve typed supported/imaginative/user-authored segments, author display identity, visible parent/chain metadata, scoped reaction state and current revision. `PublicLifePostView.reactions` contains `{reactionId, active}` for the current viewer's configured reactions only. Its changing state participates in cursor scope; it is excluded from the immutable `PublicLifePost` used for frozen reply material. No raw task IDs, source proofs, tokens, other recipients or hidden attachment references are serialized. Until070, no image is claimed attached. UI rendering/token storage remain with their owner; the backend/proxy contract and real HTTP verification are this unit's work.

## Execution, accounting and causal input

Extend the existing runner admission with a publication-drain operation using the same active slot, foreground checks, abort handling, clock and world lease. The existing scheduler may drain configured automatic publication work at its current wake/step boundary; manual publication requests use the same admission. No per-post timers and no separate native/provider instance. Unknown model outcomes reconcile from the existing native journal before any retry. Never-dispatched reservations may be released; dispatched/unknown usage remains reserved across lease loss, settings changes and restart.

A job freezes its permitted material and deterministic request ID before native preparation. Publication jobs have one narration call per attempt; `maxJobsPerRun`, chain limits/cooldown, existing `maxModelCalls` and shared world token usage jointly bound a drain. Both autonomous and publication reservations see each other's pending/spent/unknown records in the same SQLite transaction. The current fleet selection branches explicitly on request version: v1 retains its existing step guard, v2 resolves the saved publication job and validates original material, grant/settings/profile/model route and TaskManager proof. The same check runs immediately before the gateway fetch. Completed native receipts replay without inference; a publication commit still requires current authority.

Reply/reaction/reshare mutations first authenticate the principal and inspect a currently visible parent. They persist a request receipt plus one interaction atomically. Reaction add/remove sets explicit state; retries and an already-equal state produce no duplicate observation. Reshare audience is a subset of the original current audience; reply audience intersects its parent and author policy. No parent text survives a later permission failure in output or model input. Agent jobs may choose no_reply/no_post, which is a durable terminal decision. A job failure remains inspectable and needs explicit eligible retry; unknown dispatch is not silently retried.

Each effective permitted interaction produces deduplicated recipient observation receipts and a trusted `LifeInput` version3 branch (`source.kind = publication_interaction`). It carries interaction/post IDs, the actual principal, recipient agent, typed action, permitted text and root/depth. Only the publication transaction can admit this branch; the generic application-input API still cannot mint trusted publication/work sources. Extend parsing, exact replay, source membership and permission filtering for every consumer.

New autonomy steps use a version3 envelope with a frozen publication-input authority snapshot. Preserve version1/2 saved steps/model JSON exactly. Revocation changes future eligibility and stales pending use; old accepted fictional events remain history. At step acceptance, permitted feedback becomes a scoped neutral experience/claim and is consumed once. Actor/reflection input contains only that agent's allowed feedback. Existing optional reflection may change mood/goals/habits/attitudes using that experience; the HTTP interaction itself never directly writes personality or relationships. Root/depth and per-chain action receipts survive all agent replies, reshares and observation inputs, preventing a reply from resetting the chain. Exhausted chains remain visible with stopped processing, without further inference or recursive inputs.

## Audited planning ownership map

This records the original allocation before implementation. The actual module
map above supersedes proposed helper/test names that were consolidated into the
existing owners. The create/store/decode/consume and authority obligations remain.

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

## A round1 synthesis and amendments

Both independent reviews returned FAIL with five verified contract omissions. Main accepts all five; none is deferred to B without a concrete design. Evidence is `publication-a-core-round1.md` and `publication-a-runtime-round1.md`. The amendments below supersede any less-specific wording above.

### C1 — retain050 work behavior in stepv3

Add MODIFY `world/work-experience.ts`, `work-ancestry.ts` and their persistence/audit consumers `work-persistence.ts` to the field map. Their current `step.version !== 2` early returns must explicitly accept the new known version3 while preserving version1 behavior and rejecting unknown versions. Every v3 step still freezes the complete v2 work snapshot/ancestry; publication inputs supplement it. Do not infer empty work merely because the envelope version changed. Recheck all version comparisons, not only type names, including shared persona serialization and model-input builders.

Activation: use the same permitted actual work receipt on equivalent v2/v3 step fixtures and compare experience/ancestry output (reviewer's original probe produced1/4 versus0/0). Then run source revoke, destination restriction, correction, once-only consumption and actual-file reopen through v3. The original v1/v2 serialized model fixtures stay exact. Model requests for a v3 simulation step remain the v1 step-request branch; their final native guard additionally validates the frozen publication-input authority snapshot.

### C2 — shared lease history includes publication runs

Add MODIFY `world/autonomy-schedule.ts`. Add durable `life_publication_runs` plus append-only run lease/attempt history to the schema. Schedule continuity reads the union of known autonomous step leases and publication run leases, not just `life_steps`. Validate generation, token sequence and owner consistency; a publication-only world has the same protection. Publication run creation and its acquired lease snapshot are one transaction. Lease takeover/resume records a new history row, preserving the old fencing evidence. Heartbeat updates do not erase ownership history.

Before schema7 tables exist, legacy validation observes only the known old owners; after creation, both owner sets are audited. Do not fabricate missing historic lease generations during migration. Activation: real reopen after publication-only runs and mixed step/run histories; delete schedule, regress generation/token below a saved publication lease, or substitute owner at the same fence. Each must reject without partial migration. Expired lease recovery and a legitimate newer takeover must succeed, with the old worker's dispatch/commit rejected.

### C3 — feedback cannot reset its publication chain through a new event

Add MODIFY `world/autonomy-rules.ts` and NEW `publication-ancestry.ts` with world-owned ancestry rows for accepted step events and scheduled causal events. Publication ancestry is a canonical set of `{rootId, depth}` entries, not a single root chosen from several inputs. An interaction inherits its parent post's set and increments the applicable depth. An accepted v3 step inherits the union from its consumed permitted publication inputs and its scheduled causal parent. Duplicated roots take the maximum depth. New event publication candidates and further scheduled causal events inherit that set; `decision.parent === null` does not reset roots when feedback was consumed.

These ancestry rows are written with the accepted step/observation consumption and validated by replay on reopen. A v3 event that requires ancestry cannot fall back to a fresh root when its row is missing. Legacy candidates without publication feedback may establish a new root once. The existing v1 effect JSON can keep its eventId payload: the job joins its accepted event to the required ancestry row. Each effective interaction, causal descendant and automatic post charges/checks every inherited root's configured depth/action limit atomically. A mixed-root event is held if any root is exhausted; merging, reshare or audience splitting never grants fresh allowance.

This tracks the explicit feedback/scheduled-work chain. An independent clock-driven event with neither newly consumed feedback nor a causal parent may start a new root; historical personality changes do not permanently label every future independent event. Current and scheduled input ancestry is still mandatory even if a model claims its event is unrelated. Activation: reply→consumed feedback→ordinary autonomous event with no decision.parent→new post→reply, across restart; mixed roots, quiet feedback steps and scheduled follow-ups; all must retain original limits and eventually stop new feedback-driven inference/publication. Past posts/experiences remain inspectable under current permission.

### R1 — explicit dispatch eligibility and reconciliation entry points

The scheduler checks publication work before its simulation-only early returns. It still has one wait/wake loop. A committed candidate/interaction, explicit publication retry, config/settings change and native-result recovery signal wake that loop. Automatic publication needs publication.mode automatic, complete publication/model/usage settings, no foreground work and an explicitly configured global run mode that is not paused. It may drain on these existing wakes when simulation mode is manual; no recurring interval is invented. Automatic simulation drains ready publication work before selecting its next step and after a new accepted step. A quiet step is not a reason to skip older pending publication work.

Global run.mode paused blocks automatic new inference and automatic post commits. An explicit owner `/publication/run` may manually drain while simulation is paused, provided publication/model/usage settings are configured and current; this is a distinct trusted manual admission, not a body flag accepted from a model or viewer. `run:null` remains not configured. Publication cooldown counts accepted LIFE revisions (the completed-step counter), including valid older LIFE worlds without autonomous state; it is not an inferred wall-clock interval.

Reconciliation is a separate no-new-inference operation under the same runner ownership. Existing unknown publication attempts can inspect their saved native journal while paused or needs_attention. It may record the already-observed result/usage and leave a ready decision, but paused automatic reconciliation does not publish it. Unknown simulation requests remain with the simulation owner; shared unknown reservations block every new model dispatch. Manual/automatic calls first reconcile their own fixed pending runs and then check shared accounting. No busy timer repeatedly probes unknown jobs: recovery/wake or explicit owner invocation retries the read.

Activation: manual simulation plus automatic publication wake; paused automatic publication with zero new inference/commit; paused explicit manual drain; quiet step with an older queued candidate; unknown publication result recovered while paused; unknown simulation usage blocking a new publication job. Assert concrete runner calls, native prepare/dispatch/reconcile counts and durable outcomes with an injected clock and real HTTP/native journal fixtures.

### R2 — a drain request owns a frozen batch

`life_publication_runs` binds `(worldId, requestKey)` to the exact request digest, config/settings revisions, ordered selected job/attempt IDs, current progress, lease history and terminal result. Freeze that bounded list and persist the run before any native preparation. Even an empty or blocked run has a durable result. A repeated key with the same payload resumes or returns only that list/result; it never discovers later jobs. A changed payload conflicts. New arrivals require a new run key. Automatic wakes also persist a distinct deterministic run key from the pending frontier and policy revisions, then use the identical frozen-batch path; interrupted runs resume before admitting another batch.

Active authority changes can withhold the remaining fixed jobs but cannot replace them with different work. A terminal replay performs no new dispatch or publication. Run status/job metadata is an owner response, never a viewer feed response. Activation: maxJobsPerRun1, process A and lose the HTTP response, enqueue B, retry the original key before and after process reopen. Only A's original result returns; B stays pending until a new run key. Add concurrent same-key, changed-key-payload, partial-batch failure, stale settings and empty-run-then-new-work cases.

### B clarification: frozen causal activity allowance

New v3 step sources include `publicationBudget`: the original settings revision
and explicit limits, chain-history sequence/digest/root counts, and deterministic
blocked observation/queued-event IDs. Permission evidence stays separate. An
exhausted member blocks the complete pending feedback group. Independent clock
events may proceed without consuming or receiving that feedback. Queued events
also check inherited roots before selection. Current same-root spending stales
prepared work before dispatch; unrelated roots do not revoke unused allowance.

`publication-budget.ts` computes admission without a database or model. The chain
SQL owner supplies a validated current/historical prefix. Acceptance charges the
step and each admitted causal child on every inherited root, in stable child-ID
order and the same transaction as consumption, outcome and ancestry. Children
that do not fit remain stopped. Step execution and further queued actions each
count as activity; model tokens retain their separate existing accounting owner.

Startup verifies the original prefix/exclusions and exact step/child charge
receipts. Removing a last causal charge and adjusting the remaining counters into
a valid older prefix still fails the cross-owner audit. Older v1/v2 JSON remains
unchanged; synthetic legacy fixtures remove all v3 fields, including this budget.

Current B logs under the bound evidence directory: budget-regression-green has29
tests/95 assertions, budget-runtime-first has3/33, budget-current-history has2/12,
and budget-reopen-negative has5/16 (all prefixed `publication-`, all exit0).
`publication-budget-types-final.log` records root/browser types exit0. Runtime
probes use real stores and the isolated social runner with synthetic responses.
Independent budget review passed after the interaction-charge and total-root-capacity repairs (`publication-budget-review.md`); this is not the complete060 C gate.

### B clarification: reply execution ownership

The concrete variant, ancestor-proof and one-charge contract is in
[061](061_reply_contract.md). It refines this same060 work phase. Implementation
and the bounded provenance review passed; final whole-unit review is in progress.

The agent post owner will also own model-generated replies with supported and
imaginative segments. The interaction reply-post owner retains user-authored
replies/reshares. Generated text must not be labelled user-authored. Reply jobs
use an explicit versioned parent-post source, not a fabricated world event,
accepted step or event intent. Common jobs, attempts, model reservations and run
batches remain the execution boundary; `no_reply` is a terminal skipped outcome.

An authorized drain may discover one reply candidate per visible parent, agent
and audience. Initial posts and replies are eligible parents; agents do not
discover replies to their own posts. Audiences intersect current parent visibility
and explicit agent mappings. Reads alone discover nothing. Narration receives
only allowed parent segments with their supported/imaginative/user-authored tags
and shareable author voice. User assertions do not become verified claims. Frozen
material retains the parent/revision link, while serving, dispatch and commit
recheck the complete current parent chain.

Publishing an agent reply records its interaction observation in the same
transaction, referencing the generated post/job and original roots. It must not
create a second text-only reply. Original grants, recipient mappings, retirement,
settings and work restrictions apply before further observations or inference.
Exact codecs, historical checks and the finite A/B reply loop are implemented
and exercised by the reply-source, generated-loop and generated-feedback suites.

`LifeRunner.publish(worldId, input, signal)` shares simulation's active slot,
foreground cancellation, model port and lease owner. Explicit optional publication
dependencies come from the installation owner; absence yields not-configured.
Scheduler, native publication gateway, main HTTP routing and agent reply sources
are wired. `publishScheduled` carries scheduler authority separately from a saved
run's manual input; recovery alone never grants a new manual invocation.

### Resolved finding: policies for future events

The original exact-event fixture alone did not cover future events. Settings v2
now adds explicit authored event-family rules, disabled when unset; the contract
and tests are below. Its static public summary replaces unrestricted actor text
before projection limits. Facts, secrets and scene details retain separate
authority. No audience, background or automatic setting is selected by this fix.

### Cross-unit image/UI clarification

The stable post ID is070's `LifeImageSource.publicationId`; `materialId` names the frozen publication material, not a live world view. The internal post source retains the originating root event/revision and material digest through replies/reshares. Provide a current-authorized material accessor for the070 owner; it must not reconstruct a historic picture from today's scene or mistake a viewer projection for generation authority. No image is generated or attached in060. Viewer token mint/revoke is a local management contract for the UI owner; the feed proxy cannot bootstrap a grant for an unauthenticated browser or expose management routes.

### B runtime integration checkpoint

`WorldStore.publicationModelRecords` and `publicationExecutionStatus` now expose
the real saved request owner and shared usage/lease reads. The runner consumes
these ports directly. Manual publication is reachable through the main Fleet
HTTP router; a real Fleet/store plus synthetic model publishes, survives full
Fleet restart, and replays without a duplicate call. Feed/settings reads and
change notifications keep a cold execution owner unopened.

`automaticPublicationInput` is a read-only candidate/attempt probe. Only a drain
creates jobs or runs. A saved run is reconciled first; otherwise an explicit
automatic publication config, settings and eligible candidate are required.
Candidate attempts determine the idempotency key. Finished/failed jobs are not
rediscovered and empty reads create no run. An explicit retry changes its attempt
and next key. The existing scheduler visits publication before simulation and
after each accepted catch-up step, using
the same active runner slot, world lease, foreground cancellation and shutdown.
It wakes for actual remaining work, an existing lease expiry or the configured
rolling budget window. Unknown/paused work waits for state change or restart.
There is no new posting cadence or token allowance.

The fleet native callback now requires the exact dispatched publication model
receipt, current author/material/settings and current run lease before outbound
I/O. Codex invokes this synchronous callback after its capability check and before
the outbound journal marker and provider fetch. Native adapter tests demonstrate
denial with zero configured-provider requests and durable failed reconciliation,
plus authorized v2 completion/replay and unchanged v1 behavior. These tests use
the installed native binaries with isolated temporary state and local synthetic
Responses services, not a real paid model.

Evidence lives under `.codexclaw/evidence/01a07c47-20b9-73b1-94e2-dcea96b2d35e/`:
`publication-native-outbound-worker.md` (41 affected adapter tests),
`publication-automatic-scheduler-first.log` (16 tests),
`publication-fleet-automatic-first.log` (3 composed Fleet tests), and
`publication-fleet-scheduler-types.log` (root/browser types). The native adapter
worker's earlier root type mismatch was concurrent scheduler work and is resolved
by the latter typecheck. These are intermediate receipts; final whole-unit
re-review and C checks remain required.

The retirement worker subsequently completed and handed back current-role guards:
12 focused cases/71 assertions and527 adjacent core cases passed. Main checked the
returned source hashes/diff and repaired its own concurrent catalog formatting.
The shared scheduler also covers explicitly configured publication-only legacy
LIFE worlds, without requiring an autonomous pack or director model at startup.
New native combined proof is `publication-native-future-event-first.log`: actual
Codex/Bwrap, local synthetic Responses, permitted future-event narration, web
proxy feed/reply dedupe, full restart, and settings revocation immediately before
provider fetch;2 tests/56 assertions. It does not prove paid-model quality or UI.

### B implementation contract: future-event publication rules

Add publication settings v2 as an explicit union with the existing v1 bytes.
V1 retains its exact fields and means no future-event rule. V2 adds required
`worldVersion` and `eventRules: { familyId, authorAgentIds, recipientIds, summary }[]`.
`worldVersion` is the expected currently activated authored-pack version on save,
and the immutable reference for history validation. It prevents a forged unknown
family from passing startup just because no post has used that setting yet.
Historical validation reads that exact pack; current generation also checks the
current family/role authority. Entries are
unique by family ID, arrays contain unique identifiers, and `summary` is bounded
plain text authored by the user. Empty rules disable this capability. Existing
settings/history tables and revision/CAS ownership remain; no schema rewrite or
new default audience, timer, event setting or budget is required.

A rule applies only to a persisted accepted autonomous event whose original
step identifies that family. Verify the step/event/LIFE revision link from the
saved history, not model text or a supplied family label. Require a current
explicit rule, eligible author who knows the event, active authored role and
configured recipient intersection. Unknown families/agents or missing authored
autonomy support reject new rule settings. Existing work-origin restrictions
still apply to the event and every separately disclosed fact/claim.

For a matching rule, first validate the original stored event's provenance,
audience membership and work authority. Then derive an internal event disclosure
for the authorized author/recipient and pass a publication-only event copy with
the rule's static public summary into projection **before** collector limits,
audience intersection and material hashing. Never change the persisted event or
expand its audience. Replacing the text after collection would let private text
length affect public eligibility. Do not expose the unrestricted actor event summary,
director note, profile biography or extra facts. Names, facts, secrets and scene
descriptions still need their existing separate projection permissions. The
narrator may express a personal angle with labelled imaginative segments; it
does not gain authority to invent factual claims. Exact-event policies remain
supported independently, including on legacy LIFE records without an autonomous
pack. If an exact-event policy already authorizes the raw summary, that explicit
permission remains its authority.

Material retains its settings revision and exact source event/step provenance.
Historical validation resolves the original v1/v2 settings and immutable accepted
step, preserving old material bytes. Current dispatch/commit/feed checks use the
current rule and work authority. Changing/removing a rule withholds stale frozen
work or hides content whose claim is no longer authorized. Tests must cover at
least two generated event IDs in the same family, unset/manual legacy behavior,
private-summary canaries, forbidden facts/work ancestry, unknown family/source,
revocation during dispatch and actual reopen with both settings versions.
Changing only private-summary text/length must not change permitted material or
eligibility; oversized owner-authored public summaries must still obey the limits.
Include an inferred-experience-only author who is absent from the event audience.

Diff owners: `publication-types.ts`, `publication-validation.ts`,
`publication-persistence.ts`, `publication-material.ts`, a focused
`publication-event-rules.ts` helper and `store.ts`; new focused pure/store/native
tests and existing settings/material/recovery tests. This is a technical contract
for owner-authored policy, not a decision to turn it on in any real world.

Implemented through RED/GREEN. Original v1 settings bytes and v2 pack references
survive actual reopen; rehashed nonexistent family/actor/version references fail
startup without repair. `publicationFamily` reads the original paired LIFE commit
and checks accepted step/receipt/proposal identity before using its selected
family. `publication-event-policy-store-first.log` verifies two distinct future
events and persisted publication after rule removal/reopen. The scoped plan
review repair passed; the subsequent bounded implementation review also passed.
This alone is not060 complete.

The first implementation review found that newly prepared LIFE feedback used
the settings' old authored pack after the current family was removed. The repair
passes the LIFE source's own pack version separately from settings provenance.
`publication-family-revocation-feedback-green.log` now proves hidden feedback
does not enter a new accepted step, while old jobs still reopen (3 cases/44
assertions). `publication-native-rule-revocation.log` removes actual event rules
at the final outbound boundary and proves failed0 reconciliation/replay. The same
independent reviewer rechecked the repair and passed the future-event slice:
10 focused cases/79 assertions,2 native cases/56 assertions, types and its own
previously failing probe all pass. Whole060 remains incomplete.

The automatic queue probe also now preserves the same durable pending order as
run admission. Sorting only the probe by job ID could assign a completed run's
key to another pending batch and loop without progress. A real two-event test
with reverse-ordered pending jobs failed then passed (`publication-auto-batch-order-*`).
Fresh keys use `publication-auto-v2-`; existing running batches retain their
original input. Generated reply codecs and their material/provenance, execution,
feed and observation integration are implemented under061.

### Final review repairs and current evidence

Both full implementation reviewers initially returned FAIL. All seven findings
were accepted and repaired: shared unknown-usage fences at dispatch/outbound;
startup validation for pending job sources; current-viewer reaction state; live
TaskManager source checks on feed/interaction requests; paused scheduled recovery;
publication priority before simulation; and authenticated zero-attempt native
preflight failure receipts. Missing or corrupt native journals remain unknown.

The actual Fleet/native credential-failure test releases the reservation, reopens
the Fleet and permits one explicit new attempt. The combined native Fleet tests
pass three cases/83 assertions with only a local synthetic Responses service.
Scheduler/route regressions pass108 cases/987 assertions. The HTTP QA matrix
captures42 real curl requests through Fleet and the fixed-upstream web proxy,
including restart, exact run replay, original-grant revocation and descendant
withdrawal. Native request count stays7 across restart/replay; all temporary
listeners and fixture roots are removed. These results do not prove live model
quality, image generation or UI rendering.

Evidence: `publication-full-runtime-review-original.md`,
`publication-scheduler-repair-worker.md`, `publication-native-preflight-worker.md`,
`publication-pending-source-worker.md`, `publication-reaction-feed-worker.md`,
`publication-repaired-fleet-native.log`, `qa/publication-http/qa-receipt.json`,
`publication-qa-public-input.json` and `publication-qa-teardown.json` under the
session evidence directory.

Both full re-reviews now return PASS with no unresolved finding:
`publication-full-core-rereview.md` binds48 core source files and reports104 tests
plus47 separate probe assertions; `publication-full-runtime-rereview.md` binds20
runtime/native/web source files and reports203 passing tests. Main's final
native-enabled whole-source run passes2,885 tests/15,184 assertions across411
files. Root/browser types, lint (14 nonblocking warnings), runtime build and
out-of-checkout CLI smoke, CI metadata and document checks pass. The final CHECK
reuses these observed results only after verifying unchanged source/log hashes.

The failed earlier snapshots remain evidence of defects, not green checks. Real
model narrative quality, UI rendering, image delivery, hosted CI, merge and
deployment are outside this local result. Continue070 with the existing image
owner and then080 with explicit consumer contracts and integrated acceptance.
