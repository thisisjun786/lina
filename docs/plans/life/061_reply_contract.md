# 061 — Generated agent replies inside publication060

Status: independently reviewed contract and integrated implementation; both whole060
implementation re-reviews and its local source checks passed. This refines the
already authorized reply acceptance in [060](060_publication.md); it is part of
the same publication work phase. No new audience, activity limit, cadence, model,
budget or real-world posting permission is chosen here.

Independent plan review found and corrected the generated-reply observation
target: it must authorize the generated reply itself, not merely its parent.
The same reviewer rechecked the repair and passed the plan. Evidence:
`publication-agent-reply-plan-review.md` in the task's publication evidence folder.

## Ownership and input

`PublicationJobs`, the shared model receipt ledger, `PublicationRuns` and
`PublicationPosts` own generated agent replies. `PublicationReplyPosts` continues
to own user-written replies and reshares. Generated segments retain their claim
or imaginative tags; they are never rendered as user-authored text. One generated
reply has one post, one logical job, one activity charge and one set of scoped
observation receipts.

Preserve current event-job/material/post v1 bytes. Introduce explicit v2 reply
variants in the existing JSON owners, without fabricating a world event, event
intent or accepted autonomous step. The job key is world + parent post + author +
recipient; its attempts keep the existing retry and model-reconciliation rules.
The parent is immutable for that logical job. A changed parent revision may
withhold an attempt; it does not silently invent a second logical reply.

An authorized drain enumerates currently visible parent posts for each active,
explicitly mapped agent/recipient. Event posts, generated replies, user replies
and reshares can be parents. Skip an agent's own posts. Discover once per typed
source key; `no_reply` is terminal and not an automatic retry. Read-only feed and
queue probes do not create jobs. Automatic request keys continue to include the
actual pending attempts, so later replies are not swallowed by a completed key.

## Frozen reply material

The codec boundary uses these explicit variants. Existing interfaces become
named event variants with their public unions retaining the old import names.
Common fields keep their current validation and digest formulas.

```ts
type ReplyMaterialSource = {
  kind: "reply";
  parentPostId: string;
  parentPostRevision: number;
  parentOwner: "post" | "reply"; // SQL owner, not the displayed post kind
  worldRevision: number; // real paired snapshot at reply-material freeze
  lifeRevision: number;
  origin: EventPublicationMaterial["source"]; // real inherited event provenance
};
type ReplyPublicationMaterial = Omit<EventPublicationMaterial, "version" | "source"> & {
  version: 2;
  source: ReplyMaterialSource;
  parent: PublicLifePost;
  authority: PublicationAuthority;
  parentRoots: PublicationChainRef[];
};
type ReplyPublicationJob = Omit<EventPublicationJob, "version" | "intentId" | "material"> & {
  version: 2;
  source: { kind: "reply"; parentPostId: string };
  material: ReplyPublicationMaterial | null;
};
type ReplyPublicationPost = Omit<EventPublicationPost, "version" | "material"> & {
  version: 2;
  material: ReplyPublicationMaterial;
};
```

Reply-job identity hashes the typed parent source, author and recipient, keeping
the old event-job hash unchanged. Posts retain their existing world/job-derived
ID. The material hash covers all v2 fields, including the public parent and
authority; `permittedScene` is null. The parent ID/revision/owner matches an
authority reference; the generated post's roots equal parent roots with depth
incremented once. Reply source snapshots must not precede the origin; full
paired-snapshot and ancestor provenance checks remain storage responsibilities.
The pure codec does not claim to authenticate referenced database records.

The new reply material records:

- Exact parent post ID/revision and its public projection, including public
  author, text and claim/imaginative/user-authored segment tags.
- Original published event provenance inherited from the closest generated
  ancestor: real event ID, world/LIFE revisions and original event intent. This
  is history for causality/image contracts, never the reply job's identity.
- Frozen ancestor post/revision and viewer-grant/revision references using the
  existing `PublicationAuthority` codec. Traverse the complete parent chain
  iteratively, reject cycles/missing revisions, and retain original root IDs.
- Current publication config/settings, projection definition, work and ancestry
  revisions/digests, plus only supported claims actually rendered by the visible
  parent. Match these claims to the ancestor's immutable permitted claim record;
  text equality alone never upgrades user-authored or imaginative segments.

The narrator receives the parent's visible segments and current public voice /
shared growth. It receives no unrelated underlying material claims, private
biography, director rationale, raw experiences, grants, internal source IDs or
unpublished scene. Reply `permittedScene` is null unless a later explicit source
contract authorizes one. A user assertion remains a user assertion. The model may
refer to the supplied supported claim IDs, write labelled imaginative prose or
return `no_reply`. No new free-form factual output is admitted.

Historical reconstruction uses the original parent revisions, original grant
revisions and frozen settings/work/projection authority. Current selection,
dispatch, commit and serving recheck the current complete parent chain, parent
revision/content and relevant original grants. Revocation must hide/withhold
forbidden descendants without making accepted historical records unrecoverable.
`worldVersion` in settings v2 continues to identify its original authored policy;
it is not permission to narrate a retired actor or removed current event family.

Keep feed checks acyclic: each post's local material check validates its own
authority/content; the iterative feed resolver checks parent visibility. Full
reply admission/dispatch can use that resolver, but the resolver must not call a
material selector that recursively asks the same resolver about itself. Cache
only immutable scoped reads within one operation, never across requests.

## Posts and observations

A reply post is an explicit v2 generated post whose material identifies its
parent. Its public projection has `kind: "reply"`, `parentPostId` and its own
typed generated segments. Feed ordering, pagination, cursor validation, scoped
detail, withdrawal and descendant checks cover both generated variants and user
reply/reshares. A reshare preserves the parent segments and intersects all parent
audiences; it does not replace their provenance with user-authored text.

Add a trusted generated-reply observation path to the interaction owner. Its
versioned receipt references the existing generated post/job/attempt and verifies
them against their owners. It never invokes the user reply-post constructor.
Public reply/reaction/reshare handlers cannot supply this receipt variant.
For this new generated-reply observation, `source.postId` and `postRevision`
identify the **generated reply itself**, not its parent. Its frozen/current
authority includes that reply and the complete ancestor chain. Withdrawing only
the generated reply must remove its queued text even while the parent remains
visible. Legacy user-interaction observations keep their existing parent-based
derivation and serialized bytes.
The observation action explicitly retains the generated segments and author
attribution. Its aggregate text, including any provenance labels used for a
private experience, must fit the existing text/input bounds; reject oversized
generated output before commit, rather than truncate claims or strand a post.

The generated-reply publication charge remains `publication-${job.id}`. The
interaction receipt proves that charge instead of spending again. Startup checks
the exact job, attempt, post, actor, roots, life revision, settings revision,
original limits and cooldown semantics. Missing charges, counterfeit links,
duplicate post owners or a relabelled stopped receipt reject recovery. Every
active eligible observer gets one deduplicated v3 LIFE input in the same commit.
Generation, post, activity charge and observations commit atomically.

Existing v3 input/evidence bytes remain unchanged. New generated-reply actions
are explicitly parsed variants. Experience formation remains attributed and
uncertain; a social reply does not directly edit global truth, traits or relations.
The actor can react through the normal next-step/reflection mechanism. Any new
grant references needed by generated ancestry enter evidence only for the new
post variant; historical v1 event/user-reply authorities must derive identically.

## Finite execution

Inherit all parent roots and increment depth, never reset to a new root because
the reply lacks a new world event. Check depth, actions per chain, per-author
cooldown and current material authority before model dispatch, as well as commit.
Publication and later causal LIFE events retain the already implemented shared
budget and ancestry rules. One activity receipt charges every inherited root.
`no_reply` produces no new parent or observation; it cannot create a reply loop.

Use the existing runner's active slot, foreground cancellation, model instance,
lease renewal, shared usage ledger and reconciliation. Unknown work keeps its
reservation and exact attempt. No new provider client, timer or direct persona
mutation is needed.

## Implementation and proof

Extend the existing publication types/codecs/jobs/posts/material/runner selectors,
the iterative feed resolver, interaction receipt owner, evidence descriptor and
WorldStore composition. A focused reply-material/provenance helper may hold the
new pure contract; do not duplicate existing SQL owners or budget accounting.

Required tests:

- Two agents answer a real permitted parent, then answer each other; explicit
  depth/action/cooldown bounds terminate work before another provider call.
- One parent/agent/recipient yields one logical job across run retries, restart
  and response loss. `no_reply` stays skipped. Unknown requests never reroll.
- User-authored and imaginative parent text never become supported claims.
  Unposted but otherwise permitted facts never enter narration.
- Parent withdrawal, original viewer-grant revocation, actor retirement and work
  revocation before dispatch/commit deny output; after commit they hide forbidden
  descendants while original history still opens.
- Withdraw only the generated reply before step preparation and after preparation
  but before dispatch. Exclude its observation or reject stale dispatch, form no
  new experience from its text, and still reopen accepted historical records.
- Mixed generated/user replies/reshares, deep chains and cycle/corruption cases
  use iterative checks and retain roots/typed text without duplicate post rows.
- One published agent reply has one activity charge and one observation per
  eligible active agent; a later real LIFE step sees the words/provenance and
  forms a scoped experience. Reads alone leave inputs/revisions unchanged.
- Historical v1 jobs/material/posts, v1 interaction receipts and accepted v3
  source envelopes remain byte-compatible through actual database reopen.
- Capture real native/local-synthetic provider requests and the protected
  HTTP/web-proxy result. Report model quality, image generation and UI as their
  separate acceptance layers.

## B implementation checkpoint

Reply v2 codecs preserve the original event bytes. The actual store now selects
visible parent content from published decision receipts, freezes ancestor and
grant references, discovers typed reply jobs, and persists generated posts or
terminal `no_reply` decisions. Both decisions survive a real database reopen.
Revoking an original viewer grant hides its generated descendants without
destroying accepted history. The combined authority and existing evidence check
passed 42 tests with 152 assertions (`publication-generated-authority-green.log`).

The subsequent checkpoint below supersedes this intermediate result. Generated
observations, finite two-agent activity and native/Fleet integration are now
implemented and included in the whole060 source checks.

## Integrated reply checkpoint

The existing runner now publishes generated replies, stores one scoped observation
per eligible recipient, and consumes those observations in a later real v3 LIFE
step as private told/unknown experience. Generated child withdrawal before or
after preparation excludes/fences its source. Real native Codex plus a local
synthetic Responses server also exercised event publication, web-proxy viewer
comment, generated reply, full Fleet restart and exact replay with no extra call.
This proves transport/integration, not model quality or paid-provider behavior.

The two-agent loop checks explicit depth, action count and cooldown before further
model calls. A race where another interaction spent the last slot during model
preparation was reproduced and fixed at dispatch. Oversized rendered observation
text rolls back actual post/charge/observation writes while retaining the returned
model receipt. Recovery rejects a removed generated observation graph even when
post/job/charge history remains valid.

Independent bounded provenance review passed after repairing retired generated
authors remaining visible; current and historical role authority are now distinct.
Full060 core/runtime re-reviews and native-enabled whole-source checks now pass;
the final source-bound receipt and scope are recorded in060. Evidence is
in the session folder: publication-reply-provenance-review.md,
publication-generated-feedback-first.log, publication-generated-native-first.log,
publication-dispatch-capacity-regression.log and
publication-generated-oversize-rollback.log.
